package main

import (
	"flag"
	"fmt"
	"os"
	"runtime/debug"

	"nossl.sh/mmdb-builder/mmdb"
)

func main() {
	asDir := flag.String("as-dir", "as", "ASN directory with per-ASN aggregated.json files")
	outPath := flag.String("asn-out", "ip2asn-nossl-sh.mmdb", "ASN output mmdb path")
	countryDir := flag.String("country-dir", "", "country directory with per-country aggregated.json files")
	countryOutPath := flag.String("country-out", "ip2geo-nossl-sh.mmdb", "country output mmdb path")
	geofeedDir := flag.String("geofeed-dir", "", "geofeed directory with RFC 8805 .cache files")
	patchMMDBPath := flag.String("patch-mmdb", "", "existing mmdb path to patch in-place")
	patchGeofeedPath := flag.String("patch-geofeed", "", "geofeed patch source (file or directory)")
	testMMDB := flag.String("test-mmdb", "", "mmdb path to test against ips.txt and builtin IPs")
	testIP := flag.String("ip", "", "single IP to test with -test-mmdb (overrides ips.txt and builtin IPs)")
	debugMode := flag.Bool("debug", false, "include network (inetnum) in mmdb records")
	flag.Parse()

	if *patchMMDBPath != "" || *patchGeofeedPath != "" {
		if *patchMMDBPath == "" || *patchGeofeedPath == "" {
			fmt.Fprintln(os.Stderr, "error: -patch-mmdb and -patch-geofeed must be set together")
			os.Exit(2)
		}
		mmdb.PatchWithGeofeed(*patchMMDBPath, *patchGeofeedPath, *debugMode)
		if *testMMDB != "" {
			mmdb.PrintLookups(*testMMDB, *testIP)
		} else if *testIP != "" {
			fmt.Fprintln(os.Stderr, "error: -ip requires -test-mmdb")
			os.Exit(2)
		}
		return
	}

	asDirSet := false
	countryDirSet := false
	geofeedDirSet := false
	flag.CommandLine.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "as-dir":
			asDirSet = true
		case "country-dir":
			countryDirSet = true
		case "geofeed-dir":
			geofeedDirSet = true
		}
	})

	asnAvailable := false
	if *asDir != "" {
		info, err := os.Stat(*asDir)
		if err == nil && info.IsDir() {
			asnAvailable = true
		} else if (countryDirSet && !asDirSet) || (*testMMDB != "" && !asDirSet) {
			fmt.Fprintf(os.Stderr, "warning: ASN directory not found: %s (skipping)\n", *asDir)
		} else {
			fmt.Fprintf(os.Stderr, "error: ASN directory not found: %s\n", *asDir)
			os.Exit(2)
		}
	}

	countryAvailable := false
	if *countryDir != "" {
		info, err := os.Stat(*countryDir)
		if err == nil && info.IsDir() {
			countryAvailable = true
		} else {
			fmt.Fprintf(os.Stderr, "error: country directory not found: %s\n", *countryDir)
			os.Exit(2)
		}
	} else if countryDirSet {
		fmt.Fprintln(os.Stderr, "error: country directory not set")
		os.Exit(2)
	}

	geofeedAvailable := false
	geofeedCacheDir := ""
	if *geofeedDir != "" {
		cacheDir, err := mmdb.ResolveGeofeedCacheDir(*geofeedDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: geofeed directory invalid: %v\n", err)
			os.Exit(2)
		}
		geofeedAvailable = true
		geofeedCacheDir = cacheDir
	} else if geofeedDirSet {
		fmt.Fprintln(os.Stderr, "error: geofeed directory not set")
		os.Exit(2)
	}

	if !asnAvailable && !countryAvailable && !geofeedAvailable && *testMMDB == "" {
		fmt.Fprintln(os.Stderr, "error: no input directories provided")
		os.Exit(2)
	}

	if asnAvailable {
		stats, err := mmdb.BuildASN(*asDir, *outPath, *debugMode)
		if stats.Skipped > 0 {
			fmt.Fprintf(os.Stderr, "warning: skipped %d ASN entries\n", stats.Skipped)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("wrote %s (%d ASN entries, %d prefixes)\n", *outPath, stats.Entries, stats.Prefixes)
		debug.FreeOSMemory()
	}
	if countryAvailable || geofeedAvailable {
		countryDirPath := ""
		if countryAvailable {
			countryDirPath = *countryDir
		}
		mmdb.BuildCountry(countryDirPath, geofeedCacheDir, *countryOutPath, *debugMode)
		debug.FreeOSMemory()
	}

	if *testMMDB != "" {
		mmdb.PrintLookups(*testMMDB, *testIP)
	} else if *testIP != "" {
		fmt.Fprintln(os.Stderr, "error: -ip requires -test-mmdb")
		os.Exit(2)
	}
}
