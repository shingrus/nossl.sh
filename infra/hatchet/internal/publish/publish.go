// Package publish uploads build artifacts to Cloudflare R2 and GitHub releases
// and pings healthchecks.io after a successful publish.
package publish

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// R2 uploads to one Cloudflare R2 bucket through its S3-compatible API.
type R2 struct {
	client *minio.Client
	bucket string
}

func NewR2(accountID, accessKeyID, secretAccessKey, bucket string) (*R2, error) {
	if accountID == "" || accessKeyID == "" || secretAccessKey == "" || bucket == "" {
		return nil, fmt.Errorf("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required")
	}
	client, err := minio.New(accountID+".r2.cloudflarestorage.com", &minio.Options{
		Creds:  credentials.NewStaticV4(accessKeyID, secretAccessKey, ""),
		Secure: true,
		Region: "auto",
	})
	if err != nil {
		return nil, err
	}
	return &R2{client: client, bucket: bucket}, nil
}

// Upload puts the local file at key and returns its r2:// location.
func (r *R2) Upload(ctx context.Context, key, path string) (string, error) {
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if _, err := r.client.FPutObject(ctx, r.bucket, key, path, minio.PutObjectOptions{ContentType: contentType}); err != nil {
		return "", fmt.Errorf("upload %s to r2://%s/%s: %w", path, r.bucket, key, err)
	}
	return fmt.Sprintf("r2://%s/%s", r.bucket, key), nil
}

// GitHubRelease replaces one asset on a rolling release, creating the release if needed.
type GitHubRelease struct {
	Token      string
	Repo       string // owner/name
	Tag        string
	Name       string
	BodyFormat string // %s receives the build date tag
	HTTP       *http.Client
}

func NewGitHubRelease(token, repo string) (*GitHubRelease, error) {
	if token == "" || !strings.Contains(repo, "/") {
		return nil, fmt.Errorf("GITHUB_TOKEN and GITHUB_REPO (owner/name) are required")
	}
	return &GitHubRelease{
		Token:      token,
		Repo:       repo,
		Tag:        "latest",
		Name:       "Latest MMDBs",
		BodyFormat: "Rolling release.\n\nLast build date: %s",
		HTTP:       &http.Client{Timeout: 10 * time.Minute},
	}, nil
}

type release struct {
	ID        int64   `json:"id"`
	UploadURL string  `json:"upload_url"`
	Assets    []asset `json:"assets"`
}

type asset struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	URL                string `json:"url"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// UploadAsset uploads path as assetName and returns the stable latest download URL.
func (g *GitHubRelease) UploadAsset(ctx context.Context, path, assetName, dateTag string) (string, error) {
	body := fmt.Sprintf(g.BodyFormat, dateTag)
	rel, found, err := g.releaseByTag(ctx)
	if err != nil {
		return "", err
	}
	if !found {
		rel, err = g.jsonRequest(ctx, http.MethodPost, g.apiURL("releases"), map[string]any{
			"tag_name": g.Tag, "name": g.Name, "body": body, "draft": false,
			"prerelease": false, "generate_release_notes": false, "make_latest": "true",
		})
	} else {
		rel, err = g.jsonRequest(ctx, http.MethodPatch, g.apiURL(fmt.Sprintf("releases/%d", rel.ID)), map[string]any{
			"name": g.Name, "body": body, "draft": false, "prerelease": false, "make_latest": "true",
		})
	}
	if err != nil {
		return "", err
	}

	for _, a := range rel.Assets {
		if a.Name == assetName {
			if err := g.do(ctx, http.MethodDelete, a.URL, nil, "", nil); err != nil {
				return "", fmt.Errorf("delete old asset %s: %w", assetName, err)
			}
			break
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	uploadURL := strings.SplitN(rel.UploadURL, "{", 2)[0] + "?" + url.Values{"name": {assetName}}.Encode()
	if err := g.do(ctx, http.MethodPost, uploadURL, bytes.NewReader(data), "application/octet-stream", nil); err != nil {
		return "", fmt.Errorf("upload asset %s: %w", assetName, err)
	}
	return fmt.Sprintf("https://github.com/%s/releases/latest/download/%s", g.Repo, url.PathEscape(assetName)), nil
}

func (g *GitHubRelease) apiURL(path string) string {
	return fmt.Sprintf("https://api.github.com/repos/%s/%s", g.Repo, path)
}

func (g *GitHubRelease) releaseByTag(ctx context.Context) (release, bool, error) {
	var rel release
	err := g.do(ctx, http.MethodGet, g.apiURL("releases/tags/"+url.PathEscape(g.Tag)), nil, "", &rel)
	if httpErr, ok := err.(*httpError); ok && httpErr.status == http.StatusNotFound {
		return rel, false, nil
	}
	return rel, err == nil, err
}

func (g *GitHubRelease) jsonRequest(ctx context.Context, method, endpoint string, payload any) (release, error) {
	var rel release
	encoded, err := json.Marshal(payload)
	if err != nil {
		return rel, err
	}
	err = g.do(ctx, method, endpoint, bytes.NewReader(encoded), "application/json", &rel)
	return rel, err
}

type httpError struct {
	status int
	body   string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("GitHub API request failed with HTTP %d: %s", e.status, e.body)
}

func (g *GitHubRelease) do(ctx context.Context, method, endpoint string, body io.Reader, contentType string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &httpError{status: resp.StatusCode, body: strings.TrimSpace(string(respBody))}
	}
	if out != nil && len(respBody) > 0 {
		return json.Unmarshal(respBody, out)
	}
	return nil
}

// Ping calls a healthchecks.io ping URL; an empty URL is a no-op.
func Ping(ctx context.Context, pingURL string) error {
	if pingURL == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pingURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("healthcheck ping returned HTTP %d", resp.StatusCode)
	}
	return nil
}
