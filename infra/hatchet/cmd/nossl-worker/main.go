// Command nossl-worker runs the nossl data pipelines as a Hatchet worker, or
// runs a pipeline once locally without Hatchet.
//
//	nossl-worker                       # serve: connect to Hatchet (HATCHET_CLIENT_TOKEN)
//	nossl-worker run-asn [-skip-publish] [-skip-domains]
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	hatchet "github.com/hatchet-dev/hatchet/sdks/go"

	"nossl.sh/hatchet/internal/asn"
	"nossl.sh/hatchet/internal/config"
)

// BuildASNInput is the workflow input; cron runs use the zero value.
type BuildASNInput struct {
	// SkipPublish builds everything but uploads nothing (for manual test runs).
	SkipPublish bool `json:"skip_publish"`
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	var err error
	switch command {
	case "serve":
		err = serve(ctx)
	case "run-asn":
		err = runASN(ctx, os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q (want serve or run-asn)", command)
	}
	if err != nil {
		slog.Error("nossl-worker failed", "err", err)
		os.Exit(1)
	}
}

func serve(ctx context.Context) error {
	cfg := config.FromEnv()
	client, err := hatchet.NewClient()
	if err != nil {
		return fmt.Errorf("create Hatchet client: %w", err)
	}
	worker, err := client.NewWorker("nossl-worker",
		hatchet.WithWorkflows(buildASNWorkflow(client, cfg)),
		hatchet.WithSlots(4),
	)
	if err != nil {
		return fmt.Errorf("create worker: %w", err)
	}
	slog.Info("worker starting", "data_dir", cfg.DataDir)
	return worker.StartBlocking(ctx)
}

// asnDBLimit serializes every workflow that writes the ASN tables. The pdb job
// will declare the same tenant-scoped limit when it moves to this worker.
func asnDBLimit() hatchet.Concurrency {
	maxRuns := int32(1)
	strategy := hatchet.GroupRoundRobin
	return hatchet.Concurrency{
		Name:           "asn-db",
		IsTenantScoped: true,
		Expression:     "'asn-db'",
		MaxRuns:        &maxRuns,
		LimitStrategy:  &strategy,
	}
}

func pipelineFor(ctx hatchet.Context, cfg config.Config) *asn.Pipeline {
	return &asn.Pipeline{Config: cfg, Progress: func(msg string) {
		slog.Info(msg)
		ctx.Log(msg)
	}}
}

func buildASNWorkflow(client *hatchet.Client, cfg config.Config) *hatchet.Workflow {
	wf := client.NewWorkflow("build-asn-data",
		hatchet.WithWorkflowDescription("ipverse/asn-ip -> Postgres -> ip2asn MMDB + asn.sqlite3 -> R2 / GitHub release"),
		hatchet.WithWorkflowCron("15 */12 * * *"),
		hatchet.WithWorkflowConcurrency(asnDBLimit()),
	)
	retry := []hatchet.TaskOption{hatchet.WithRetries(2), hatchet.WithRetryBackoff(2, 300)}
	withRetry := func(opts ...hatchet.TaskOption) []hatchet.TaskOption {
		return append(append([]hatchet.TaskOption{}, retry...), opts...)
	}

	sync := wf.NewTask("sync-source", func(ctx hatchet.Context, _ BuildASNInput) (asn.Source, error) {
		return pipelineFor(ctx, cfg).SyncSource(ctx, time.Now())
	}, withRetry(hatchet.WithExecutionTimeout(30*time.Minute))...)

	source := func(ctx hatchet.Context) (asn.Source, error) {
		var src asn.Source
		err := ctx.ParentOutput(sync, &src)
		return src, err
	}

	ingest := wf.NewTask("ingest", func(ctx hatchet.Context, _ BuildASNInput) (asn.IngestStats, error) {
		src, err := source(ctx)
		if err != nil {
			return asn.IngestStats{}, err
		}
		return pipelineFor(ctx, cfg).Ingest(ctx, src)
	}, withRetry(hatchet.WithParents(sync), hatchet.WithExecutionTimeout(30*time.Minute))...)

	// Cold start is ~1 day of ARIN lookups; normal runs take minutes. Progress
	// is written to Postgres per ASN, so a retry resumes where it stopped.
	domains := wf.NewTask("domains", func(ctx hatchet.Context, _ BuildASNInput) (asn.DomainStats, error) {
		return pipelineFor(ctx, cfg).Domains(ctx)
	}, withRetry(hatchet.WithParents(ingest), hatchet.WithExecutionTimeout(24*time.Hour))...)

	mmdb := wf.NewTask("build-mmdb", func(ctx hatchet.Context, _ BuildASNInput) (asn.BuildMMDBOutput, error) {
		src, err := source(ctx)
		if err != nil {
			return asn.BuildMMDBOutput{}, err
		}
		return pipelineFor(ctx, cfg).BuildMMDB(ctx, src)
	}, hatchet.WithParents(sync, ingest), hatchet.WithExecutionTimeout(30*time.Minute))

	export := wf.NewTask("export-sqlite", func(ctx hatchet.Context, _ BuildASNInput) (asn.ExportOutput, error) {
		src, err := source(ctx)
		if err != nil {
			return asn.ExportOutput{}, err
		}
		return pipelineFor(ctx, cfg).ExportSQLite(ctx, src)
	}, withRetry(hatchet.WithParents(sync, domains), hatchet.WithExecutionTimeout(30*time.Minute))...)

	wf.NewTask("publish", func(ctx hatchet.Context, input BuildASNInput) (asn.PublishOutput, error) {
		src, err := source(ctx)
		if err != nil {
			return asn.PublishOutput{}, err
		}
		var built asn.BuildMMDBOutput
		if err := ctx.ParentOutput(mmdb, &built); err != nil {
			return asn.PublishOutput{}, err
		}
		var exported asn.ExportOutput
		if err := ctx.ParentOutput(export, &exported); err != nil {
			return asn.PublishOutput{}, err
		}
		p := pipelineFor(ctx, cfg)
		if input.SkipPublish {
			p.Progress("publish: skipped (skip_publish=true)")
			return asn.PublishOutput{}, nil
		}
		return p.Publish(ctx, src, built.Path, exported.Path)
	}, withRetry(hatchet.WithParents(sync, mmdb, export), hatchet.WithExecutionTimeout(30*time.Minute))...)

	return wf
}

// runASN runs the same steps once, in order, without Hatchet.
func runASN(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("run-asn", flag.ExitOnError)
	skipPublish := flags.Bool("skip-publish", false, "build everything but upload nothing")
	skipDomains := flags.Bool("skip-domains", false, "skip RDAP/PeeringDB domain lookups")
	flags.Parse(args)

	cfg := config.FromEnv()
	p := &asn.Pipeline{Config: cfg, Progress: func(msg string) { slog.Info(msg) }}

	src, err := p.SyncSource(ctx, time.Now())
	if err != nil {
		return err
	}
	if _, err := p.Ingest(ctx, src); err != nil {
		return err
	}
	if !*skipDomains {
		if _, err := p.Domains(ctx); err != nil {
			return err
		}
	}
	built, err := p.BuildMMDB(ctx, src)
	if err != nil {
		return err
	}
	exported, err := p.ExportSQLite(ctx, src)
	if err != nil {
		return err
	}
	if *skipPublish {
		slog.Info("publish skipped", "mmdb", built.Path, "sqlite", exported.Path)
		return nil
	}
	_, err = p.Publish(ctx, src, built.Path, exported.Path)
	return err
}
