export const SEO_PAGE_CATEGORIES = Object.freeze({
    overview: {
        title: 'Core HTTP helpers',
        description: 'Understand the nossl.sh foundation and its plain-HTTP stance.',
    },
    ipTools: {
        title: 'IP checks and CLI helpers',
        description: 'See your public IPv4/IPv6 and use curl-friendly endpoints.',
    },
    troubleshooting: {
        title: 'Captive portal troubleshooting',
        description: 'Force captive portals to appear and capture diagnostics when Wi-Fi stalls.',
    },
    mobile: {
        title: 'Mobile and Apple devices',
        description: 'Guides tailored for phones, tablets, and Apple captive network helpers.',
    },
    hotels: {
        title: 'Hotel Wi-Fi',
        description: 'Venue-specific walkthroughs for popular hotel brands.',
    },
    cafes: {
        title: 'Cafes and restaurants',
        description: 'Quick-service and coffee shop Wi-Fi login helpers.',
    },
});

export const SEO_PAGES = Object.freeze([
    {
        path: '/what-is-nossl',
        title: 'What is nossl.sh? Plain HTTP captive portal helper',
        description:
            'Understand how nossl.sh provides a modern plain HTTP landing page to trigger captive portals and verify restrictive Wi-Fi networks.',
        keywords:
            'what is nossl, nossl explained, plain http landing page, captive portal helper',
        category: 'overview',
        hero: 'What is nossl.sh?',
        tagline:
            'A modern diagnostic splash page that mirrors NeverSSL while adding live request details.',
        sections: [
            {
                heading: 'Why nossl.sh exists',
                paragraphs: [
                    'Many captive portals refuse to load on HTTPS-only sites. nossl.sh serves plain HTTP so restricted networks expose their login forms.',
                    'When you load the page it echoes your headers, IP address, and connection type so you can prove what the network sees.',
                ],
                bullets: [
                    'Trigger hotel, airport, and campus captive portals.',
                    'Validate that a device can resolve DNS and negotiate HTTP.',
                    'Inspect raw headers to debug proxy rewriting or filters.',
                ],
            },
            {
                heading: 'Key diagnostics you receive',
                paragraphs: [
                    'Beyond being a simple landing page, nossl.sh keeps a running counter of HTTP vs HTTPS requests and shows the headers your device transmits.',
                ],
                bullets: [
                    'Connection snapshot with scheme, IP, and timestamp.',
                    'Copyable JSON of every header the request sent.',
                    'Quick jump to the honeypot dashboard that tracks /.env scans.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Is nossl.sh safe to open?',
                answer:
                    'The site intentionally serves over HTTP to mimic NeverSSL. It does not run scripts that change your system, but you should only use it on networks you trust.',
            },
            {
                question: 'Can I automate checks against nossl.sh?',
                answer:
                    'Yes. Use curl or fetch the /api/request-info endpoint to capture the same data programmatically.',
            },
        ],
    },
    {
        path: '/never-ssl-alternative',
        title: 'Reliable NeverSSL alternative with strict no-SSL policy',
        description:
            'Use nossl.sh as the dependable never-SSL option when you must trigger captive portals over plain HTTP while capturing diagnostics.',
        keywords:
            'never ssl alternative, no ssl page, neverssl replacement, captive portal alternative, nossl sh',
        category: 'overview',
        hero: 'Good, stable, never-SSL alternative - nossl.sh',
        tagline:
            'nossl.sh is engineered to never negotiate SSL/TLS on its primary endpoint while delivering real diagnostics for every request.',
        sections: [
            {
                heading: 'Explicit no-SSL stance you can trust',
                paragraphs: [
                    'This endpoint exists for one purpose: stay on classic HTTP so captive portals reveal themselves. There are no surprise upgrades, HSTS headers, or certificate detours.',
                    'Teams rely on it when they need a deterministic NeverSSL clone that is actively maintained and monitored for uptime.',
                ],
                bullets: [
                    'Primary host explicitly avoids TLS handshakes.',
                    'Lightweight markup loads on e-readers, consoles, and kiosks.',
                    'Status banner confirms “Unsecure connection” so users know it worked.',
                ],
            },
            {
                heading: 'Diagnostics beyond the legacy NeverSSL splash',
                paragraphs: [
                    'While the page remains plain HTTP, it also gives you concrete evidence of what the network sees so you can troubleshoot confidently.',
                ],
                bullets: [
                    'Instant curl response that prints your public IP only (run `curl http://nossl.sh`).',
                    'Copy-ready table of headers for tickets and incident timelines.',
                    'Live counters showing HTTP vs HTTPS hits plus SEO landings.',
                ],
            },
            {
                heading: 'Useful extras for ops teams',
                paragraphs: [
                    'nossl.sh adds operational context without breaking the all-HTTP contract meant to mimic NeverSSL.',
                ],
                bullets: [
                    'Check `/api/request-info` to script public IP checks in tooling.',
                    'Monitor the honeypot console to see automated scanners that hit your network.',
                    'Use the sitemap of SEO pages to document specific onboarding scenarios for travelers.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does nossl.sh ever force HTTPS?',
                answer:
                    'No. The main helper endpoint stays on HTTP by design so captive portals cannot dodge it. A separate HTTPS preview exists, but the default route never upgrades.',
            },
            {
                question: 'How reliable is this NeverSSL alternative?',
                answer:
                    'The project is monitored 24/7, deployed across redundant regions, and backed by simple service checks so travelers and ops teams can trust it in the field.',
            },
        ],
    },
    {
        path: '/check-my-ip',
        title: 'Check my IP address (IPv4 and IPv6) instantly',
        description:
            'Use nossl.sh to view both your public IPv4 and IPv6 plus request headers on a plain HTTP page built for captive portals and diagnostics.',
        keywords: 'check my ip, whats my ip http, ipv4 ipv6 checker, public ip lookup, dual stack ip',
        category: 'ipTools',
        hero: 'Check my IP address',
        tagline:
            'See both public IPs, copy them, and share a full request snapshot without leaving HTTP.',
        sections: [
            {
                heading: 'See both addresses side by side',
                paragraphs: [
                    'The main nossl.sh page shows your IPv4 immediately and calls v6.nossl.sh in the background to reveal IPv6 when available.',
                    'Everything stays on simple HTTP so captive portals and constrained devices can still display the report.',
                ],
                bullets: [
                    'Copy IPv4 or IPv6 with one tap.',
                    'Share a support-ready snapshot with the built-in report link.',
                    'Verify dual-stack reachability without running shell tools.',
                ],
            },
            {
                heading: 'Built for quick triage',
                paragraphs: [
                    'Refresh the page after login attempts to confirm whether the network is still intercepting traffic.',
                ],
                bullets: [
                    'Counters show overall usage to prove the service is up.',
                    'Header tables expose proxies, VPNs, or custom DNS rewrites.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Will the page show IPv6 automatically?',
                answer:
                    'Yes. If your network hands out IPv6, the page fetches v6.nossl.sh and displays the address alongside IPv4 so you can prove dual-stack routing.',
            },
            {
                question: 'Is the data cached?',
                answer:
                    'No. Responses disable caching so every refresh returns a fresh timestamp and the latest IP info.',
            },
        ],
    },
    {
        path: '/check-my-ipv6',
        title: 'Check my IPv6 address over HTTP',
        description:
            'Verify IPv6 connectivity with nossl.sh using the v6.nossl.sh probe and compare it to your IPv4 address for captive portal testing.',
        keywords: 'check my ipv6, ipv6 address lookup, ipv6 test http, dual stack ipv6',
        category: 'ipTools',
        hero: 'Check my IPv6 address',
        tagline:
            'Confirm dual-stack reachability with a lightweight page that also shows your IPv4 details.',
        sections: [
            {
                heading: 'Confirm IPv6 reachability',
                paragraphs: [
                    'Load nossl.sh to see IPv4 immediately, then let the built-in v6 probe surface your IPv6 address when the network provides one.',
                    'The page stays minimal so it still works behind captive portals that block heavier IPv6 testers.',
                ],
                bullets: [
                    'Shows IPv6 only when the network announces it.',
                    'Copies IPv6 to the clipboard for tickets or chats.',
                    'Uses HTTP only to avoid TLS hiccups during onboarding.',
                ],
            },
            {
                heading: 'Why this beats generic IPv6 testers',
                paragraphs: [
                    'Most IPv6 tools assume HTTPS. nossl.sh keeps things plain while still providing shareable reports and header captures.',
                ],
                bullets: [
                    'Optional JSON API for automation.',
                    'Share link bundles both IPs and headers.',
                    'Works in kiosk, console, and smart TV browsers.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What if no IPv6 appears?',
                answer:
                    'You will still see your IPv4. If IPv6 stays blank, your network likely has no native IPv6 or is blocking the v6.nossl.sh probe.',
            },
            {
                question: 'Can I check IPv6 from the terminal?',
                answer:
                    'Yes. Run curl http://v6.nossl.sh to print your IPv6 address with a trailing newline.',
            },
        ],
    },
    {
        path: '/check-my-public-ip',
        title: 'Check my public IP with shareable IPv4 and IPv6 snapshot',
        description:
            'Get your public IPv4 and IPv6 plus a timestamped header dump that is ready to share with help desks and network teams.',
        keywords: 'check public ip, my public ip, public ipv6, public ip lookup, share ip snapshot',
        category: 'ipTools',
        hero: 'Check my public IP',
        tagline:
            'Copy IPv4, IPv6, and request headers from one refresh-ready diagnostics page.',
        sections: [
            {
                heading: 'Copy-and-share diagnostics',
                paragraphs: [
                    'Use the copy buttons or the share link to send a full report—including both public IPs—to your support channels.',
                ],
                bullets: [
                    'Share link preserves IPv6 once detected.',
                    'Headers and timestamps travel with the snapshot.',
                    'Geo hint shows which ISP or NAT is in play.',
                ],
            },
            {
                heading: 'Know exactly what the network sees',
                paragraphs: [
                    'The page shows scheme, ports, and headers so you can confirm whether a proxy or VPN is rewriting your traffic.',
                ],
                bullets: [
                    'Great for ticket attachments and incident timelines.',
                    'Plain HTTP keeps it accessible on locked-down Wi-Fi.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I hand this to support?',
                answer:
                    'Yes. Send the share link or copy the IPs directly. Everything needed for triage lives in the snapshot.',
            },
            {
                question: 'Does the page expose private device details?',
                answer:
                    'It only echoes what the request already sends—IP, headers, and timing—and is intended for diagnostics.',
            },
        ],
    },
    {
        path: '/get-my-ip',
        title: 'Get my IP address instantly over HTTP',
        description:
            'Pull your public IPv4 and IPv6 from nossl.sh on a no-SSL helper page that also shows headers for troubleshooting.',
        keywords: 'get my ip, get my ip address, whats my ip http, ipv4 ipv6 finder, my ip curl',
        category: 'ipTools',
        hero: 'Get my IP address',
        tagline:
            'Instant IP answer with copy buttons, shareable report links, and zero HTTPS friction.',
        sections: [
            {
                heading: 'Immediate dual-stack lookup',
                paragraphs: [
                    'Open nossl.sh and you will see your IPv4 right away, with an automatic call to v6.nossl.sh to surface IPv6 when the network provides it.',
                    'Everything stays lightweight and HTTP-only so captive portals cannot block it.',
                ],
                bullets: [
                    'Copy IPv4 or IPv6 with a single tap.',
                    'Refresh after login attempts to confirm the portal released you.',
                    'Works on consoles, kiosks, and embedded browsers.',
                ],
            },
            {
                heading: 'Built to share evidence',
                paragraphs: [
                    'Use the share link to send a snapshot of your IPs, headers, and timestamp to help desks or teammates.',
                ],
                bullets: [
                    'Header table shows what proxies and VPNs add.',
                    'Geo hint helps confirm which ISP or exit point you are using.',
                    'CLI-friendly with curl http://nossl.sh for plain text output.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does this work from the terminal?',
                answer:
                    'Yes. curl http://nossl.sh prints your IPv4 with a newline, and curl http://v6.nossl.sh prints IPv6 when available.',
            },
            {
                question: 'Is any data cached?',
                answer:
                    'No. Responses disable caching so each load returns a fresh timestamp, IPs, and headers.',
            },
        ],
    },
    {
        path: '/get-my-ipv6',
        title: 'Get my IPv6 address and compare it to IPv4',
        description:
            'Use nossl.sh to fetch your IPv6 address quickly, verify dual-stack reachability, and capture headers for support.',
        keywords: 'get my ipv6, ipv6 address lookup, ipv6 test http, my ipv6 address, ipv6 connectivity',
        category: 'ipTools',
        hero: 'Get my IPv6 address',
        tagline:
            'Lightweight IPv6 checker that also shows your IPv4 details on the same HTTP page.',
        sections: [
            {
                heading: 'IPv6 without friction',
                paragraphs: [
                    'The page calls v6.nossl.sh in the background so your IPv6 address appears as soon as the network provides it.',
                    'Because everything is plain HTTP, captive portals and legacy devices can still display the results.',
                ],
                bullets: [
                    'Copy IPv6 directly for tickets or chats.',
                    'Refresh after toggling VPNs or tunnels to compare exits.',
                    'See IPv4 alongside IPv6 for quick dual-stack confirmation.',
                ],
            },
            {
                heading: 'Great for NAT64 and tunnel checks',
                paragraphs: [
                    'Use the header snapshot to see whether proxies rewrite your IPv6 traffic or downgrade you to IPv4 only.',
                ],
                bullets: [
                    'Share the built-in report link with your network team.',
                    'Geo hints reveal which ASN or region your IPv6 announces from.',
                    'curl http://v6.nossl.sh returns IPv6 only when available.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What if IPv6 never shows up?',
                answer:
                    'You will still see IPv4. If IPv6 stays blank, the network likely does not hand out IPv6 or is blocking the v6 probe.',
            },
            {
                question: 'Can I force HTTPS for this page?',
                answer:
                    'The helper is designed for HTTP so captive portals cannot intercept it, but you can load the same path over HTTPS if you need to compare.',
            },
        ],
    },
    {
        path: '/check-my-ip-address',
        title: 'Check my IP address online with headers and geo hints',
        description:
            'Confirm the IP, scheme, and headers your device is sending, then copy everything to share with support or teammates.',
        keywords: 'check my ip address, check my ip headers, ip checker http, http ip lookup, what is my ip header',
        category: 'ipTools',
        hero: 'Check my IP address with headers',
        tagline:
            'See your public IPs, request headers, and connection details on a single refresh-friendly page.',
        sections: [
            {
                heading: 'Prove what the network sees',
                paragraphs: [
                    'The status banner shows whether the request arrived over HTTP or HTTPS, and the header table reveals any proxies or VPN extensions in play.',
                ],
                bullets: [
                    'Copy IPv4/IPv6 plus ports for ticket attachments.',
                    'Sorted headers make it easy to spot injected values.',
                    'Geo data helps confirm if traffic exits where you expect.',
                ],
            },
            {
                heading: 'Ready for troubleshooting handoffs',
                paragraphs: [
                    'Before filing a support ticket, generate the share link so teammates can review the exact snapshot you captured.',
                ],
                bullets: [
                    'Reload after sign-in attempts to see if the captive portal released you.',
                    'Use /api/request-info for the same data in JSON.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does this page show IPv6 too?',
                answer:
                    'Yes. When your network provides IPv6, the page fetches v6.nossl.sh and displays it alongside IPv4.',
            },
            {
                question: 'Can I automate the check?',
                answer:
                    'Fetch http://nossl.sh/api/request-info for structured JSON that includes IPs, headers, and geo when available.',
            },
        ],
    },
    {
        path: '/my-ip-location',
        title: 'My IP location lookup with plain HTTP diagnostics',
        description:
            'See your public IP, country flag, and organization hints on a lightweight nossl.sh page built for captive portal testing.',
        keywords: 'my ip location, where is my ip, ip country lookup, ip geolocation http, my ip city',
        category: 'ipTools',
        hero: 'Find my IP location',
        tagline:
            'Check which country your IP appears to come from and share the snapshot with support teams.',
        sections: [
            {
                heading: 'Confirm where your IP exits',
                paragraphs: [
                    'nossl.sh uses GeoIP data to show a country flag, name, and organization hint when available, alongside your IP addresses.',
                ],
                bullets: [
                    'Validate VPN or smart DNS exit regions.',
                    'Refresh after toggling networks to compare routes.',
                    'Everything loads over HTTP so captive portals cannot hide it.',
                ],
            },
            {
                heading: 'Shareable proof for routing issues',
                paragraphs: [
                    'Copy the report link so ISPs or workplace IT can review the same IP, geo, and header data you saw.',
                ],
                bullets: [
                    'Header table reveals any proxy rewriting.',
                    'Geo hint shows country-level location without storing personal data.',
                ],
            },
        ],
        faqs: [
            {
                question: 'How precise is the location?',
                answer:
                    'Location is country-level and based on public IP data. It is useful for routing checks but not intended for street-level accuracy.',
            },
            {
                question: 'Will private IPs show a location?',
                answer:
                    'No. Private or invalid addresses are filtered out, so the page only shows public IPs that can be geo-located.',
            },
        ],
    },
    {
        path: '/my-request-headers',
        title: 'See my request headers and IP over HTTP',
        description:
            'Echo every HTTP header your browser or device sends, alongside IP addresses and connection details, without touching HTTPS.',
        keywords: 'request headers, view my headers, http headers checker, show my headers, my ip headers',
        category: 'ipTools',
        hero: 'View my request headers',
        tagline:
            'Copyable header list plus IP, scheme, and ports—ideal for debugging proxies, VPNs, and captive portals.',
        sections: [
            {
                heading: 'Instant header echo',
                paragraphs: [
                    'Open the page to see a sorted table of every header the request carried, including user agent, languages, and forwarded addresses.',
                ],
                bullets: [
                    'Copy headers to clipboard for tickets.',
                    'Share a report link so others can verify the same snapshot.',
                    'No caching to keep the data fresh on each refresh.',
                ],
            },
            {
                heading: 'Spot network rewrites quickly',
                paragraphs: [
                    'Compare headers before and after disabling VPNs, content filters, or custom DNS to see what changes.',
                ],
                bullets: [
                    'Use /api/request-info to fetch the same data as JSON.',
                    'Geo hint and IP fields help you confirm the egress point.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does this include my user agent?',
                answer:
                    'Yes. The page displays every header received, including User-Agent, Accept-Language, and any forwarded-for values.',
            },
            {
                question: 'Can I load it from scripts?',
                answer:
                    'Yes. The JSON API returns headers and IPs in a script-friendly format while preserving the same HTTP-only behavior.',
            },
        ],
    },
    {
        path: '/curl-ifconfig',
        title: 'curl ifconfig alternative using nossl.sh',
        description:
            'Use curl against nossl.sh to print your public IPv4 or IPv6 as a drop-in ifconfig.me replacement with no TLS overhead.',
        keywords: 'curl ifconfig, curl ifconfig.me alternative, curl ifocong, curl ip address, curl ipv6',
        category: 'ipTools',
        hero: 'curl ifconfig alternative',
        tagline:
            'Run one curl command to grab IPv4 or IPv6 from nossl.sh with nothing but plain text.',
        sections: [
            {
                heading: 'One-line commands to copy',
                paragraphs: [
                    'Use curl http://nossl.sh for IPv4 and curl http://v6.nossl.sh for IPv6. Each responds with just the address and a trailing newline.',
                    'Need more detail? Hit /api/request-info with curl to get JSON headers alongside your IP.',
                ],
                bullets: [
                    'curl http://nossl.sh',
                    'curl http://v6.nossl.sh',
                    'curl -H "Accept: application/json" http://nossl.sh/api/request-info',
                ],
            },
            {
                heading: 'Why use this over ifconfig-style sites',
                paragraphs: [
                    'nossl.sh is intentionally plain HTTP so captive portals do not block it, while still exposing both public IP addresses.',
                ],
                bullets: [
                    'Lightweight response ideal for cron and scripts.',
                    'Dual-stack coverage with matching endpoints.',
                    'Shareable report if you need UI context later.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does the curl output include IPv6?',
                answer:
                    'Use the v6 endpoint for IPv6-only output; the main host stays on IPv4 so there is no ambiguity.',
            },
            {
                question: 'Can I force HTTPS instead?',
                answer:
                    'HTTPS is available, but the HTTP endpoints avoid captive portal issues and keep the commands shorter.',
            },
        ],
    },
    {
        path: '/curl-my-public-ip',
        title: 'curl my public IP (IPv4 and IPv6) with nossl.sh',
        description:
            'Grab your public IPv4 and IPv6 in scripts using curl against nossl.sh plain-text or JSON endpoints.',
        keywords: 'curl my public ip, curl public ip, curl ipv6 address, command line ip check',
        category: 'ipTools',
        hero: 'curl my public IP',
        tagline:
            'Script-friendly endpoints that return your IPv4 or IPv6 without extra markup.',
        sections: [
            {
                heading: 'Use curl for automation',
                paragraphs: [
                    'Add nossl.sh to shell scripts to record the IP each job uses when running from VPNs, CI/CD, or edge nodes.',
                    'Choose the plain-text or JSON endpoints depending on what your tooling needs.',
                ],
                bullets: [
                    'Plain text IPv4: curl http://nossl.sh',
                    'Plain text IPv6: curl http://v6.nossl.sh',
                    'JSON with headers: curl -H "Accept: application/json" http://nossl.sh/api/request-info',
                ],
            },
            {
                heading: 'Validate dual-stack egress',
                paragraphs: [
                    'Paired IPv4 and IPv6 endpoints confirm which path your traffic takes and make it easy to share with network teams.',
                ],
                bullets: [
                    'Useful for NAT64/464XLAT and tunnel troubleshooting.',
                    'Refresh to capture a new timestamp before filing tickets.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What does the response look like?',
                answer:
                    'The root endpoints return only the IP and a newline, making them safe for shell parsing. The API endpoint returns structured JSON.',
            },
            {
                question: 'Is there a rate limit?',
                answer:
                    'nossl.sh is intended for lightweight diagnostics; reasonable automation is fine, but avoid high-frequency scraping.',
            },
        ],
    },
    {
        path: '/http-status-tester',
        title: 'HTTP status code tester with redirect support',
        description:
            'Use nossl.sh/status/:code to return any HTTP status, including redirect Location headers, for client and CDN testing.',
        keywords: 'http status tester, custom status code, curl status endpoint, redirect tester, http 418',
        category: 'ipTools',
        hero: 'HTTP status code tester',
        tagline:
            'Call /status/:code to simulate responses and redirects over plain HTTP.',
        sections: [
            {
                heading: 'Simulate responses in one call',
                paragraphs: [
                    'Need to see how a browser, client, or load balancer reacts to a code? Hit /status/503, /status/418, or any code from 100-599.',
                    'Bodies are omitted for 1xx, 204, and 304 so they match real servers.',
                ],
                bullets: [
                    'curl -i http://nossl.sh/status/418',
                    'curl -i http://nossl.sh/status/204',
                    'Cache-control disabled so every request is fresh.',
                ],
            },
            {
                heading: 'Test redirects with Location',
                paragraphs: [
                    'Add a location query parameter to set the Location header on 3xx codes. Useful for SSO flows, CDN rules, or captive portal rewrites.',
                ],
                bullets: [
                    'curl -i "http://nossl.sh/status/302?location=https://example.com"',
                    'Supports 300, 301, 302, 303, 307, 308 status codes.',
                    'Plain HTTP keeps captive portals and proxies from blocking the test.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What input is allowed?',
                answer:
                    'Status codes must be integers between 100 and 599. Location values are sanitized to strip newlines before returning.',
            },
        ],
    },
    {
        path: '/test-http-status',
        title: 'Test HTTP status codes with nossl.sh and curl',
        description:
            'Use nossl.sh to test any HTTP status in one command, like curl http://nossl.sh/status/418 for the classic teapot response.',
        keywords:
            'test http status, http status tool, curl status code, http status checker, http redirect test',
        category: 'ipTools',
        hero: 'Test HTTP status codes',
        tagline:
            'Quickly verify how clients handle any status from 100 to 599 with plain HTTP calls.',
        sections: [
            {
                heading: 'Copy-and-run examples',
                paragraphs: [
                    'Answer the popular "test http status" query with simple curl commands against nossl.sh/status/:code, no setup required.',
                    'Everything stays on HTTP so you can run these checks on captive portals, kiosks, and restricted networks.',
                ],
                bullets: [
                    'curl -i http://nossl.sh/status/418',
                    'curl -i "http://nossl.sh/status/302?location=https://example.com"',
                    'curl http://nossl.sh/status/204 (no body by design)',
                ],
            },
            {
                heading: 'Why this tester helps',
                paragraphs: [
                    'Simulate redirects, client errors, and server errors without standing up a new service or editing configs.',
                    'Responses disable caching so every request is fresh when you retest.',
                ],
                bullets: [
                    'Supports any integer status code from 100 through 599.',
                    'Strips newlines from Location headers to keep output predictable.',
                    'Great for regression checks in CI or monitoring scripts.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Do all codes return a body?',
                answer:
                    '1xx, 204, and 304 responses omit the body to mirror real servers. Others include a short plain-text line.',
            },
            {
                question: 'Can I test HTTPS behavior too?',
                answer:
                    'Yes, but start with HTTP for captive portals or constrained devices. Switch to HTTPS if you need to compare redirect handling across schemes.',
            },
        ],
    },
    {
        path: '/wifi-login-page',
        title: 'Wi-Fi login page tester for captive networks',
        description:
            'Use nossl.sh to force Wi-Fi login pages to appear, confirm captive portal redirects, and capture the headers your hardware sends.',
        keywords: 'wifi login page, captive wifi test, wifi splash page, network onboarding',
        category: 'troubleshooting',
        hero: 'Check your Wi-Fi login page',
        tagline:
            'Open this page on any device to trigger the captive portal challenge and capture connection metadata.',
        sections: [
            {
                heading: 'Trigger the splash screen manually',
                paragraphs: [
                    'Loading http://nossl.sh gives access points the HTTP handshake they require to reveal captive forms or voucher prompts.',
                    'If you are stuck on a looping login, compare headers to confirm whether a proxy or VPN is still enabled.',
                ],
            },
            {
                heading: 'How support teams use the data',
                paragraphs: [
                    'Help desks capture the request snapshot and share it with network admins. The consistent layout keeps troubleshooting quick during peak check-in hours.',
                ],
                bullets: [
                    'Record timestamps of login attempts.',
                    'Identify user agents that portals might block.',
                    'Verify if custom DNS resolvers are interfering.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Will this page complete my authentication?',
                answer:
                    'nossl.sh does not authenticate you, but it reliably launches the captive portal so you can sign in.',
            },
            {
                question: 'Can I share the counters with hotel staff?',
                answer:
                    'Absolutely. The counters provide neutral evidence that many guests successfully reach the site.',
            },
        ],
    },
    {
        path: '/mobile-wifi',
        title: 'Mobile Wi-Fi captive portal troubleshooting',
        description:
            'Get phones and tablets online by using nossl.sh to trigger captive portals, inspect HTTP headers, and confirm open internet access.',
        keywords: 'mobile wifi captive portal, phone wifi login, tablet wifi help',
        category: 'mobile',
        hero: 'Mobile Wi-Fi diagnostics',
        tagline:
            'Ideal for iOS, Android, and ChromeOS when the network refuses to show a login screen.',
        sections: [
            {
                heading: 'Quick tips for phones and tablets',
                paragraphs: [
                    'Disable private relay or VPN apps temporarily, then load nossl.sh to nudge the captive network into presenting its challenge.',
                    'If the portal still will not load, capture the headers and share them with your mobile carrier or venue support.',
                ],
            },
            {
                heading: 'Useful mobile-only checks',
                paragraphs: [
                    'Use the copy buttons to paste details into chat apps while you stay on the captive network.',
                ],
                bullets: [
                    'Compare IPv4 vs IPv6 presentation.',
                    'Confirm language headers match the splash page you expect.',
                    'Measure response time using the inline latency tool.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does nossl.sh work inside in-app browsers?',
                answer:
                    'Yes. The markup is lightweight and loads even when the captive portal opens inside a restricted web view.',
            },
            {
                question: 'What if my device blocks HTTP entirely?',
                answer:
                    'Some enterprise configurations force HTTPS. In that case, ask your administrator to temporarily allow nossl.sh over HTTP so onboarding can complete.',
            },
        ],
    },
    {
        path: '/check-wifi-login',
        title: 'Check Wi-Fi login redirect and captive portal status',
        description:
            'Verify whether your Wi-Fi network redirects to a captive portal, and document the HTTP headers observed by the portal.',
        keywords: 'check wifi login, wifi redirect test, captive portal redirect',
        category: 'troubleshooting',
        hero: 'Check your Wi-Fi login flow',
        tagline:
            'Run a manual check of the captive redirect and capture shareable diagnostics for your IT team.',
        sections: [
            {
                heading: 'Steps to validate the login flow',
                paragraphs: [
                    'Connect to the Wi-Fi network, then visit nossl.sh. The page shows whether the request was rewritten, redirected, or blocked.',
                ],
                bullets: [
                    'Record the connection scheme (HTTP or HTTPS).',
                    'Copy headers to confirm captive portal cookies.',
                    'Share the generated timestamp with support teams.',
                ],
            },
            {
                heading: 'After you authenticate',
                paragraphs: [
                    'Reload the page to confirm the portal releases your device back onto the open internet.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What if I never see the captive portal?',
                answer:
                    'Try forgetting the network, turning off cellular failover, and reloading the page. Some venues also require you to accept terms inside a companion app.',
            },
        ],
    },
    {
        path: '/nossl-page',
        title: 'Plain HTTP nossl page for captive portal access',
        description:
            'Bookmark the nossl page that hotels, airports, and enterprises rely on to bring up captive portals and expose request headers.',
        keywords: 'nossl page, plain http page, captive portal test page',
        category: 'overview',
        hero: 'Your go-to nossl page',
        tagline:
            'One lightweight destination that always responds over HTTP and documents what the network sees.',
        sections: [
            {
                heading: 'Share with your traveling team',
                paragraphs: [
                    'Sales and field engineers can rely on a consistent URL for every trip. The counters prove uptime and reliability to wary venue admins.',
                ],
            },
            {
                heading: 'Integrate into monitoring flows',
                paragraphs: [
                    'Use the JSON API to alert you when HTTP access fails, indicating that a firewall update might be blocking captive portal triggers.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Do I need to clear cache between visits?',
                answer:
                    'The page sends cache-control headers instructing browsers not to cache, ensuring every refresh reflects a new handshake.',
            },
            {
                question: 'Can I embed the nossl page inside documentation?',
                answer:
                    'Yes. Link directly to the page or iframe it inside an internal wiki to guide teammates through captive login checks.',
            },
        ],
    },
    {
        path: '/check-wifi-connection',
        title: 'Check Wi-Fi connection with HTTP diagnostics',
        description:
            'Confirm Wi-Fi connectivity by loading nossl.sh, reviewing HTTP headers, and capturing the timestamp of your request.',
        keywords: 'check wifi connection, wifi diagnostics, wifi captive portal check',
        category: 'troubleshooting',
        hero: 'Check Wi-Fi connection status',
        tagline:
            'Quickly validate that DNS, routing, and captive portal flows are functioning.',
        sections: [
            {
                heading: 'Network validation checklist',
                paragraphs: [
                    'Use the connection snapshot to confirm the network presents you with an IP address and route to the internet.',
                ],
                bullets: [
                    'Ensure the scheme reports HTTP after login.',
                    'Verify latency to confirm the gateway responds quickly.',
                    'Monitor the SEO counter to spot spikes in captive portal usage.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What does a zero latency measurement mean?',
                answer:
                    'If latency reads as zero, the inline script is still measuring—wait a moment and it will update.',
            },
        ],
    },
    {
        path: '/get-captive-portal',
        title: 'Get a captive portal to appear on demand',
        description:
            'Follow simple steps to coax stubborn captive portals into loading using nossl.sh and HTTP diagnostics.',
        keywords: 'get captive portal, captive portal url, force captive portal',
        category: 'troubleshooting',
        hero: 'Get the captive portal to load',
        tagline:
            'Troubleshoot splash screens by providing the plain HTTP request networks expect.',
        sections: [
            {
                heading: 'Step-by-step instructions',
                paragraphs: [
                    '1. Connect to the Wi-Fi network but stay on the login screen.',
                    '2. Open http://nossl.sh in your browser. If redirected, accept any prompts.',
                    '3. After authentication, refresh to verify open internet access.',
                ],
            },
            {
                heading: 'What to check if it fails',
                paragraphs: [
                    'Disable VPN clients, captive network assistants, or custom DNS filters temporarily. Then reload the page to re-trigger the HTTP handshake.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I bookmark a direct captive portal URL?',
                answer:
                    'Most venues rotate portal URLs. nossl.sh is safer because it always redirects to the correct address for the network you are on.',
            },
        ],
    },
    {
        path: '/get-captive-portal-url',
        title: 'Find the captive portal URL your network uses',
        description:
            'Learn how to expose the captive portal URL by starting on nossl.sh, then watching the redirect chain from the network gateway.',
        keywords: 'get captive portal url, captive portal link, wifi login url',
        category: 'troubleshooting',
        hero: 'Get the captive portal URL',
        tagline:
            'Capture the redirect address so you can share it with support teams or automate onboarding scripts.',
        sections: [
            {
                heading: 'Capture the URL safely',
                paragraphs: [
                    'Open nossl.sh and watch the address bar. Once redirected, copy the captive portal link before signing in.',
                    'Share the link with your administrators so they can whitelist it or pre-load content on managed devices.',
                ],
            },
            {
                heading: 'Avoid stale bookmarks',
                paragraphs: [
                    'Because portals rotate tokens, start from nossl.sh each time to receive the freshest URL.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Why do some portals hide the URL?',
                answer:
                    'Portals often use dynamic hosts for security. Capturing the redirect via nossl.sh ensures you get the current hostname.',
            },
        ],
    },
    {
        path: '/how-to-get-captive-portal',
        title: 'How to get the captive portal to show up',
        description:
            'Practical steps to make captive portals appear, including DNS resets and HTTP-only checks through nossl.sh.',
        keywords: 'how to get captive portal, captive portal troubleshooting, wifi login help',
        category: 'troubleshooting',
        hero: 'How to get a captive portal working',
        tagline:
            'Run through a concise checklist and use nossl.sh to confirm each fix.',
        sections: [
            {
                heading: 'Captive portal checklist',
                paragraphs: [
                    'Toggle airplane mode, forget and rejoin the network, then visit nossl.sh. If you still see the SEO counter climb without redirects, the venue might have an outage.',
                ],
                bullets: [
                    'Reset DNS to automatic before joining.',
                    'Disable content blockers until after login.',
                    'Capture screenshots of the connection snapshot for support.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Should I trust captive portals that warn about certificates?',
                answer:
                    'Certificate warnings may indicate interception. If the venue confirms it is safe, proceed; otherwise, ask for an alternative onboarding method.',
            },
        ],
    },
    {
        path: '/help-connect-you-to-wifi',
        title: 'Help connecting to Wi-Fi with captive portal tips',
        description:
            'Use nossl.sh and the included troubleshooting checklist to help friends, guests, or customers connect to Wi-Fi quickly.',
        keywords: 'help connect to wifi, wifi assistance, captive portal support',
        category: 'troubleshooting',
        hero: 'Help someone connect to Wi-Fi',
        tagline:
            'Guide others through captive portal hurdles with a repeatable process.',
        sections: [
            {
                heading: 'Share this process',
                paragraphs: [
                    'Send them http://nossl.sh and have them read their connection snapshot aloud. That information helps you diagnose issues remotely.',
                ],
                bullets: [
                    'Confirm they see their IP populate.',
                    'Check if the request headers reveal lingering VPN extensions.',
                    'Ask them to reload after login to ensure full internet access.',
                ],
            },
            {
                heading: 'Document recurring problems',
                paragraphs: [
                    'Use the counters as lightweight analytics to prove how often guests rely on the helper page.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I embed instructions in a QR code?',
                answer:
                    'Yes. Generate a QR code that points directly to the desired nossl.sh SEO page for quick scanning.',
            },
        ],
    },
    {
        path: '/apple-captive-portal',
        title: 'Apple captive portal troubleshooting with nossl.sh',
        description:
            'Resolve issues with Apple\'s captive portal assistant by manually visiting nossl.sh and reviewing the connection snapshot.',
        keywords: 'apple captive portal, iphone captive portal, mac captive portal',
        category: 'mobile',
        hero: 'Fix Apple captive portal issues',
        tagline:
            'Works with iPhone, iPad, and macOS to trigger the login screen when the captive assistant fails.',
        sections: [
            {
                heading: 'When the captive assistant stalls',
                paragraphs: [
                    'Open Safari and load nossl.sh directly. The site provides the HTTP handshake that macOS and iOS expect from Apple\'s original test domains.',
                ],
            },
            {
                heading: 'Share diagnostics with IT',
                paragraphs: [
                    'Export the JSON headers and send them to your help desk so they can compare against Apple CNA behavior.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I reset the Apple captive portal cache?',
                answer:
                    'Toggle Wi-Fi off and on, forget the network, or reboot the device. Loading nossl.sh after that sequence usually forces a fresh login.',
            },
        ],
    },
    {
        path: '/iphone-wifi-connect',
        title: 'Help your iPhone connect to Wi-Fi captive portals',
        description:
            'Guide to solving iPhone Wi-Fi captive portal problems by using nossl.sh and basic network resets.',
        keywords: 'iphone wifi connect, iphone captive portal, iphone wifi help',
        category: 'mobile',
        hero: 'Connect your iPhone to Wi-Fi',
        tagline:
            'Use nossl.sh as a lightweight captive portal trigger plus troubleshooting checklist.',
        sections: [
            {
                heading: 'Before you open nossl.sh',
                paragraphs: [
                    'Turn off Private Relay, disable VPNs, and forget any stale network profiles. Then join the Wi-Fi again.',
                ],
            },
            {
                heading: 'What to look for on the page',
                paragraphs: [
                    'Check that the status shows “Unsecure connection.” If it reports HTTPS, your phone may still be tunneling traffic.',
                ],
                bullets: [
                    'Confirm the IP matches the venue range.',
                    'Tap copy to send headers to support.',
                    'Reload after login to ensure the scheme flips to HTTP.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Do I need to disable content blockers?',
                answer:
                    'Temporarily disable Safari content blockers until after you authenticate—they can block captive scripts required for login.',
            },
        ],
    },
    {
        path: '/captive-portal',
        title: 'Captive portal detection and diagnostics',
        description:
            'Figure out how captive portals behave and fix issues faster with nossl.sh. It’s a simple tool that helps devices trigger those Wi-Fi login pages every time, without any fuss.',
        keywords:
            'captive portal, wifi login, captive portal test, captive portal detection, captive portal troubleshooting, nossl',
        category: 'troubleshooting',
        hero: 'Debug captive portals with confidence',
        tagline:
            'nossl.sh lets you trigger and troubleshoot captive portals on public Wi-Fi, enterprise networks, or even tiny embedded systems.',
        sections: [
            {
                heading: 'Reliable captive portal triggers',
                paragraphs: [
                    'Most operating systems check for internet by making plain old HTTP requests. nossl.sh gives you a clean, predictable endpoint that acts just like these checks, making sure your network’s splash page pops up when it should.',
                ],
                bullets: [
                    'Works out of the box with macOS, iOS, Windows, Android, and Linux.',
                    'Perfect for hotels, airports, guest Wi-Fi, or custom access gateways.',
                    'Fast, lightweight responses — great for embedded or low-power devices.',
                ],
            },
            {
                heading: 'Capture and analyze connection flow',
                paragraphs: [
                    'With nossl.sh, you can see exactly how DNS, redirects, and HTTP requests behave during captive portal logins. Spot problems like broken proxies or endless authentication loops in no time.',
                ],
                bullets: [
                    'Check the raw headers to debug captive network intercepts.',
                    'Works with curl, wget, or straight from your browser.',
                    'Turn on optional analytics to see how real users (and bots) reach your splash page.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What is a captive portal?',
                answer:
                    'A captive portal is that web page you get when you connect to public Wi-Fi and have to sign in or agree to terms before you can actually get online.',
            },
            {
                question: 'Can I use nossl.sh to test captive portal detection?',
                answer:
                    'Absolutely. nossl.sh is built to copy the endpoints devices use to trigger login pages, so it’s perfect for testing Wi-Fi networks and router setups.',
            },
        ],
    },
    {
        path: '/how-captive-portals-work',
        title: 'How captive portals work (simple explanation)',
        description:
            'Learn how captive portals function, why Wi-Fi shows a login page, and how nossl.sh provides the clean HTTP request they expect.',
        keywords:
            'how captive portals work, what is a captive portal, wifi login explained, captive portal meaning',
        category: 'overview',
        hero: 'How captive portals work',
        tagline:
            'Plain-language walkthrough of the Wi-Fi login screens you see in hotels, cafes, campuses, and airports.',
        sections: [
            {
                heading: 'What a captive portal is doing',
                paragraphs: [
                    'A captive portal sits between you and the open internet until you accept terms, enter a room or voucher, or acknowledge an acceptable-use policy.',
                    'Businesses use it to register guests, comply with regulations, and keep track of who is online.',
                ],
                bullets: [
                    'Appears right after you join Wi-Fi but before other sites load.',
                    'Common on hotel, cafe, campus, and airport networks.',
                    'Usually clears you once you tap Accept or sign in.',
                ],
            },
            {
                heading: 'How devices trigger the portal',
                paragraphs: [
                    'Laptops and phones send a tiny plain-HTTP request to check if the internet is reachable. Gateways intercept that request and redirect you to the portal page.',
                    'nossl.sh mirrors those HTTP checks so the portal sees a predictable, easy-to-catch request.',
                ],
                bullets: [
                    'HTTP is used instead of HTTPS so the network can intercept it.',
                    'The gateway rewrites the request to the login or terms page.',
                    'If nothing appears, a VPN, custom DNS, or content blocker may be hiding the check.',
                ],
            },
            {
                heading: 'Why captive portals get stuck',
                paragraphs: [
                    'Portals rely on redirects, cookies, and DNS. If any of those fail, the splash page can loop or stall.',
                    'Opening nossl.sh gives you a timestamped header snapshot you can share with staff when the portal refuses to load.',
                ],
                bullets: [
                    'Private relay or VPN tools can prevent interception.',
                    'Stale device profiles or cached redirects keep you quarantined.',
                    'Corporate HTTPS enforcement can block the plain HTTP handshake.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Is a captive portal the same as a firewall?',
                answer:
                    'No. A captive portal is a temporary gate used for sign-in or acknowledgment. After you pass it, the network’s normal firewall rules take over.',
            },
            {
                question: 'How can I get through a captive portal faster?',
                answer:
                    'Join the Wi-Fi, disable VPNs or custom DNS briefly, open http://nossl.sh, follow the login prompt, then refresh the page to confirm open internet access.',
            },
        ],
    },
    {
        path: '/marriott-wifi-login',
        title: 'Marriott Wi-Fi login guide for hotels and resorts',
        description:
            'Trigger the Marriott Bonvoy captive portal, verify room or conference access, and capture your connection details with nossl.sh.',
        keywords: 'marriott wifi login, marriott captive portal, marriott bonvoy wifi, marriott internet help',
        category: 'hotels',
        hero: 'Marriott Wi-Fi login help',
        tagline:
            'Use nossl.sh to make the Marriott captive portal appear, record headers, and prove you are online.',
        sections: [
            {
                heading: 'Connect to the right MarriottBonvoy network',
                paragraphs: [
                    'Choose the MarriottBonvoy SSID first when you join the hotel Wi-Fi. Other common names include MarriottBonvoy_Guest, brand_Guest, MarriottBonvoy_Public, Brand_Public, or Brand_Conference.',
                    'If you do not see a matching network or you hit connection errors, clear your cache and ask the Front Desk to confirm the correct SSID and help you connect.',
                ],
                bullets: [
                    'Pick MarriottBonvoy if it appears; otherwise select the guest or public option that fits your stay.',
                    'Brand_Conference networks can require coordinator instructions before you get online.',
                    'If a password prompt appears, the Front Desk can provide it.',
                ],
            },
            {
                heading: 'Finish the captive portal sign-in',
                paragraphs: [
                    'On phones, tablets, and Macs the connection screen usually opens automatically. On Windows PCs or if it does not appear, open a browser and go to www.marriottwifi.com to load it.',
                    'Follow the on-screen prompts to complete your connection. You may be asked for your room number and last name and then routed to the Property Portal with hotel details.',
                ],
                bullets: [
                    'Member and Non-Member options can show; Non-Members can join Marriott Bonvoy through the portal before connecting.',
                    'If the portal stalls, toggle Wi-Fi and retry from http://nossl.sh to hand the gateway a clean HTTP request.',
                    'Stay in touch with the Front Desk if the splash loops even after you clear cache or try again.',
                ],
            },
            {
                heading: 'Upgrades, portal links, and terms',
                paragraphs: [
                    'After you are online, type internetupgrade.marriott.com into your browser if you want to upgrade speed during your stay.',
                    'To return to the Property Portal at any time, visit stay.marriottbonvoy.com.',
                    'Review internet terms at https://www.marriott.com/marriott/internet-access/termsofuse.mi and Marriott Bonvoy program terms at https://www.marriott.com/loyalty/terms/default.mi.',
                ],
                bullets: [
                    'Keep a timestamped header snapshot from nossl.sh if you need to show support what the network sees.',
                    'Check with the Front Desk if any step is unclear or you cannot get the captive portal to finish.',
                ],
            },
        ],
        faqs: [
            {
                question: 'How do I connect to the hotel Wi-Fi?',
                answer:
                    'Pick MarriottBonvoy or MarriottBonvoy_Guest from your network list (brand_Guest or Brand_Public are common backups). If you cannot find the SSID or you see errors, clear cache, forget and rejoin the network, and ask the Front Desk for the correct name or password.',
            },
            {
                question: 'What if the captive portal does not appear?',
                answer:
                    'On Windows PCs open a browser and go to www.marriottwifi.com to trigger it. If it still loops, disable VPNs or custom DNS, toggle Wi-Fi, and retry from http://nossl.sh so the gateway sees a plain HTTP request.',
            },
            {
                question: 'Can I share proof with Marriott staff?',
                answer:
                    'Yes. Copy the headers, IP, and timestamp from nossl.sh and share them with the Front Desk or meeting coordinator to speed up whitelisting or conference troubleshooting.',
            },
        ],
    },
    {
        path: '/starbucks-wifi-login',
        title: 'Starbucks Wi-Fi login and captive portal tips',
        description:
            'Force the Starbucks Wi-Fi splash screen to appear and verify your device is cleared to browse using nossl.sh.',
        keywords: 'starbucks wifi login, starbucks wifi portal, starbucks internet, coffee shop wifi help',
        category: 'cafes',
        hero: 'Starbucks Wi-Fi login steps',
        tagline:
            'Great for travelers who need the Starbucks portal to load reliably while grabbing a coffee.',
        sections: [
            {
                heading: 'Trigger the coffee shop splash',
                paragraphs: [
                    'Connect to Starbucks Wi-Fi, then visit nossl.sh to provide the plain HTTP handshake the captive portal expects.',
                ],
                bullets: [
                    'Confirms the network is not blocking HTTP.',
                    'Shows your public IP for support chats.',
                    'Fast enough for low-power devices and e-readers.',
                ],
            },
            {
                heading: 'If you stay stuck',
                paragraphs: [
                    'Forget the network, toggle Wi-Fi, and retry from nossl.sh. The counters prove the request reached the gateway.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Is Starbucks Wi-Fi safe to use?',
                answer:
                    'Stick to HTTPS sites after you log in and consider a VPN once the captive portal releases you.',
            },
            {
                question: 'Does Starbucks require an account?',
                answer:
                    'Some locations ask for an email acknowledgment. Use nossl.sh first to get the prompt.',
            },
        ],
    },
    {
        path: '/mcdonalds-wifi-login',
        title: 'McDonald’s Wi-Fi login troubleshooting',
        description:
            'Bring up the McDonald’s Wi-Fi splash page, confirm the captive gateway, and capture the network headers for support.',
        keywords: 'mcdonalds wifi login, mcdonalds wifi portal, mcd wifi help, mcdonalds internet',
        category: 'cafes',
        hero: 'McDonald’s Wi-Fi login help',
        tagline:
            'Use nossl.sh as your clean HTTP landing page when the McDonald’s portal will not load.',
        sections: [
            {
                heading: 'Make the splash screen appear',
                paragraphs: [
                    'Load nossl.sh to trigger the captive portal that some McDonald’s locations require before browsing.',
                ],
                bullets: [
                    'Check if DNS resolves correctly on the public network.',
                    'Copy the request snapshot for the restaurant manager.',
                    'Verify the connection scheme switches to HTTP after login.',
                ],
            },
            {
                heading: 'Stuck on a redirect loop?',
                paragraphs: [
                    'Turn off VPN or private relay, refresh nossl.sh, and watch the headers for any proxy rewriting.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I use this on in-store kiosks?',
                answer:
                    'Yes. The page is lightweight and works on most kiosk browsers to prove the network path.',
            },
            {
                question: 'How do I share my findings?',
                answer:
                    'Copy the headers from the page or export the JSON at /api/request-info for support.',
            },
        ],
    },
    {
        path: '/subway-wifi-login',
        title: 'Subway Wi-Fi login page helper',
        description:
            'Launch the Subway Wi-Fi captive portal and confirm internet access using nossl.sh diagnostics.',
        keywords: 'subway wifi login, subway wifi portal, subway internet access, sandwich shop wifi',
        category: 'cafes',
        hero: 'Subway Wi-Fi login tips',
        tagline:
            'Ideal when the sandwich shop network needs an HTTP nudge before letting you browse.',
        sections: [
            {
                heading: 'Start with a clean HTTP request',
                paragraphs: [
                    'Open nossl.sh after joining the Subway Wi-Fi SSID so the gateway can present its terms page.',
                ],
                bullets: [
                    'Shows whether HTTPS forced redirects are blocking you.',
                    'Records a timestamped connection snapshot.',
                    'Quick to load even on older phones.',
                ],
            },
            {
                heading: 'If the portal times out',
                paragraphs: [
                    'Forget the network, reconnect, and retry nossl.sh. Share the headers with staff if it still fails.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does every Subway offer Wi-Fi?',
                answer:
                    'Availability varies by location, but nossl.sh can still confirm whether the SSID responds at all.',
            },
        ],
    },
    {
        path: '/burger-king-wifi-login',
        title: 'Burger King Wi-Fi login and captive portal check',
        description:
            'Force the Burger King Wi-Fi splash to load and verify the connection path with nossl.sh diagnostics.',
        keywords: 'burger king wifi login, bk wifi portal, burger king internet, cafeteria wifi help',
        category: 'cafes',
        hero: 'Burger King Wi-Fi login help',
        tagline:
            'Great for travelers relying on Burger King Wi-Fi while on the road.',
        sections: [
            {
                heading: 'Open the splash reliably',
                paragraphs: [
                    'Visit nossl.sh right after connecting so the captive portal sees a plain HTTP request.',
                ],
                bullets: [
                    'Confirms the network is issuing an IP address.',
                    'Captures headers that may include the gateway hostname.',
                    'Helps spot adblockers that interfere with the redirect.',
                ],
            },
            {
                heading: 'After accepting the terms',
                paragraphs: [
                    'Reload the page to ensure the scheme reads HTTP and the counters increment, proving you are off the walled garden.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Why does the portal take long to load?',
                answer:
                    'During busy hours the gateway can be slow; nossl.sh lets you confirm the request reached it without cached assets.',
            },
        ],
    },
    {
        path: '/taco-bell-wifi-login',
        title: 'Taco Bell Wi-Fi login tips',
        description:
            'Load the Taco Bell Wi-Fi captive page, verify internet release, and capture connection info with nossl.sh.',
        keywords: 'taco bell wifi login, taco bell portal, taco bell internet, fast food wifi help',
        category: 'cafes',
        hero: 'Taco Bell Wi-Fi helper',
        tagline:
            'A dependable HTTP landing page that makes the Taco Bell captive portal surface.',
        sections: [
            {
                heading: 'Trigger the captive check',
                paragraphs: [
                    'Open nossl.sh immediately after joining the Taco Bell network to prompt the login acknowledgment.',
                ],
                bullets: [
                    'Shows whether HTTPS enforcement blocks the redirect.',
                    'Provides a copyable IP and header set for troubleshooting.',
                    'Lightweight for budget Android devices.',
                ],
            },
            {
                heading: 'Stay online after login',
                paragraphs: [
                    'If browsing drops, revisit nossl.sh to confirm whether the gateway moved you back behind the splash page.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Do I need to disable VPN?',
                answer:
                    'Yes, VPNs can hide HTTP traffic from the captive portal. Turn it off, log in, then re-enable if desired.',
            },
        ],
    },
    {
        path: '/kfc-wifi-login',
        title: 'KFC Wi-Fi login helper',
        description:
            'Unstick the KFC Wi-Fi captive portal and gather a shareable connection snapshot using nossl.sh.',
        keywords: 'kfc wifi login, kfc portal, kfc internet access, quick service wifi',
        category: 'cafes',
        hero: 'KFC Wi-Fi login steps',
        tagline:
            'Use nossl.sh to get the Colonel’s Wi-Fi portal to appear and verify you are clear to browse.',
        sections: [
            {
                heading: 'Kick off the captive flow',
                paragraphs: [
                    'Load nossl.sh to send a plain HTTP request that typically triggers the KFC splash page.',
                ],
                bullets: [
                    'Confirms DNS and routing from the restaurant network.',
                    'Provides a timestamped record for the store manager.',
                    'Helps identify blockers like content filters.',
                ],
            },
            {
                heading: 'If the splash loops',
                paragraphs: [
                    'Disable private relay, refresh the page, and check the scheme indicator for signs of HTTPS interception.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I test with curl?',
                answer:
                    'Yes. `curl http://nossl.sh` returns your IP only—handy for CLI validation while on KFC Wi-Fi.',
            },
        ],
    },
    {
        path: '/wendys-wifi-login',
        title: 'Wendy’s Wi-Fi login and captive portal guide',
        description:
            'Prompt the Wendy’s Wi-Fi splash screen and verify open internet access using nossl.sh diagnostics.',
        keywords: 'wendys wifi login, wendys wifi portal, wendys internet, fast food wifi',
        category: 'cafes',
        hero: 'Wendy’s Wi-Fi helper',
        tagline:
            'A quick way to show the store’s gateway your device is ready for the portal.',
        sections: [
            {
                heading: 'Trigger the login page',
                paragraphs: [
                    'Connect to the Wendy’s SSID and hit nossl.sh to send the plain HTTP request the captive portal expects.',
                ],
                bullets: [
                    'Confirms the gateway assigns you an IP.',
                    'Shows headers the network receives for ticketing.',
                    'Great for tablets used in the dining area.',
                ],
            },
            {
                heading: 'Document the result',
                paragraphs: [
                    'Copy the header table or JSON output if you need to ask staff to reset the access point.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does Wendy’s Wi-Fi timeout quickly?',
                answer:
                    'Some stores enforce session limits. Reload nossl.sh to see if you have been pushed back behind the captive portal.',
            },
        ],
    },
    {
        path: '/panera-wifi-login',
        title: 'Panera Wi-Fi login helper for cafes',
        description:
            'Get the Panera Bread Wi-Fi login page to load, confirm speed, and capture your connection headers with nossl.sh.',
        keywords: 'panera wifi login, panera wifi portal, panera bread internet, cafe wifi help',
        category: 'cafes',
        hero: 'Panera Wi-Fi login steps',
        tagline:
            'Use nossl.sh while you work from the cafe to keep the captive portal honest.',
        sections: [
            {
                heading: 'Force the splash to appear',
                paragraphs: [
                    'Open nossl.sh on laptops or tablets to trigger the Panera captive portal if it stalls.',
                ],
                bullets: [
                    'Verifies whether the network blocks HTTP to certain domains.',
                    'Provides latency measurements for your workstation.',
                    'Copyable diagnostics for remote IT teams.',
                ],
            },
            {
                heading: 'Stay connected between sessions',
                paragraphs: [
                    'If Panera rotates login tokens, revisit nossl.sh to refresh the session and ensure you are routed to open internet.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I preload this in a QR code?',
                answer:
                    'Yes. A QR to http://nossl.sh lets teammates trigger the Panera portal immediately.',
            },
        ],
    },
    {
        path: '/dunkin-wifi-login',
        title: 'Dunkin’ Wi-Fi login page tips',
        description:
            'Bring up the Dunkin’ Wi-Fi captive portal, verify HTTP access, and export diagnostics using nossl.sh.',
        keywords: 'dunkin wifi login, dunkin donuts wifi, dunkin internet portal, coffee wifi help',
        category: 'cafes',
        hero: 'Dunkin’ Wi-Fi helper',
        tagline:
            'Perfect for commuters hopping on Dunkin’ Wi-Fi between stops.',
        sections: [
            {
                heading: 'Trigger the captive prompt',
                paragraphs: [
                    'Visit nossl.sh to give the Dunkin’ gateway the HTTP request it needs to show the login page.',
                ],
                bullets: [
                    'Confirms whether your device is blocked by MAC filtering.',
                    'Captures the gateway headers for support calls.',
                    'Works on budget Chromebooks often used by students.',
                ],
            },
            {
                heading: 'If the page will not load',
                paragraphs: [
                    'Toggle Wi-Fi, disable VPN, and retry nossl.sh. Share the timestamped snapshot with staff if it still hangs.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Is it safe to log in on public Wi-Fi?',
                answer:
                    'Use the network to reach the portal, then switch to HTTPS sites or a VPN once authenticated.',
            },
        ],
    },
    {
        path: '/chick-fil-a-wifi-login',
        title: 'Chick-fil-A Wi-Fi login walkthrough',
        description:
            'Prompt the Chick-fil-A Wi-Fi login page, validate the connection release, and gather diagnostics via nossl.sh.',
        keywords: 'chick fil a wifi login, chick fil a portal, cfa wifi, chicken wifi help',
        category: 'cafes',
        hero: 'Chick-fil-A Wi-Fi helper',
        tagline:
            'Use nossl.sh when the Chick-fil-A captive portal stalls during a meal.',
        sections: [
            {
                heading: 'Start with nossl.sh',
                paragraphs: [
                    'Open the page to generate the HTTP request most captive portals look for before granting access.',
                ],
                bullets: [
                    'Shows whether the gateway is intercepting HTTPS instead.',
                    'Provides counters proving the request landed.',
                    'Lightweight enough for in-app browsers on phones.',
                ],
            },
            {
                heading: 'Share proof with staff',
                paragraphs: [
                    'Copy the header table and present it to store team members if you need a quick AP reboot.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does Chick-fil-A throttle speeds?',
                answer:
                    'Some markets rate-limit guest Wi-Fi. Use the latency indicator on the page to spot slowdowns.',
            },
        ],
    },
    {
        path: '/hilton-wifi-login',
        title: 'Hilton Wi-Fi login troubleshooting',
        description:
            'Force the Hilton hotel Wi-Fi captive portal to load and confirm billing or room access flows via nossl.sh.',
        keywords: 'hilton wifi login, hilton captive portal, hilton honors wifi, hotel wifi help',
        category: 'hotels',
        hero: 'Hilton Wi-Fi login help',
        tagline:
            'Great for Hilton Honors guests who need a reliable HTTP trigger for the login page.',
        sections: [
            {
                heading: 'Trigger the Hilton splash',
                paragraphs: [
                    'Join the Hilton SSID, then hit nossl.sh to send the unencrypted request most gateways wait for.',
                ],
                bullets: [
                    'Shows whether the portal injects your room number prompt.',
                    'Captures headers for the front desk IT partner.',
                    'Useful for conference center access points too.',
                ],
            },
            {
                heading: 'Confirm open internet',
                paragraphs: [
                    'After authentication, reload to ensure the scheme remains HTTP and not trapped behind SSL interception.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Why do I get certificate warnings?',
                answer:
                    'Some Hilton portals intercept HTTPS. Stick to nossl.sh first so you can safely accept the captive portal flow.',
            },
        ],
    },
    {
        path: '/hyatt-wifi-login',
        title: 'Hyatt Wi-Fi login helper',
        description:
            'Prompt the Hyatt guest Wi-Fi login screen, verify your device is cleared, and retain diagnostics using nossl.sh.',
        keywords: 'hyatt wifi login, hyatt captive portal, hyatt wifi help, hotel wifi troubleshoot',
        category: 'hotels',
        hero: 'Hyatt Wi-Fi login tips',
        tagline:
            'Designed for Hyatt guests who need a clean HTTP page to wake the captive portal.',
        sections: [
            {
                heading: 'Kickstart the captive portal',
                paragraphs: [
                    'Open nossl.sh after joining Hyatt Wi-Fi to send the simple HTTP request the gateway expects.',
                ],
                bullets: [
                    'Confirms DNS and routing through the hotel network.',
                    'Offers copyable headers for the concierge desk.',
                    'Works on Chromebooks used in conference rooms.',
                ],
            },
            {
                heading: 'If elite login fails',
                paragraphs: [
                    'Disable VPN, clear cached redirects, and reload nossl.sh. Share the JSON output with Hyatt support for whitelisting.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I save the URL for offline help?',
                answer:
                    'Yes. Bookmark http://nossl.sh so you can open it immediately after connecting to Hyatt Wi-Fi.',
            },
        ],
    },
    {
        path: '/holiday-inn-wifi-login',
        title: 'Holiday Inn Wi-Fi login guide',
        description:
            'Get the Holiday Inn captive portal to appear, check routing, and document the connection using nossl.sh.',
        keywords: 'holiday inn wifi login, ihg wifi portal, holiday inn internet, hotel wifi help',
        category: 'hotels',
        hero: 'Holiday Inn Wi-Fi helper',
        tagline:
            'A straightforward HTTP page to make the IHG captive portal show up.',
        sections: [
            {
                heading: 'Launch the portal',
                paragraphs: [
                    'Visit nossl.sh after joining the Holiday Inn SSID so the gateway can redirect you to the login form.',
                ],
                bullets: [
                    'Captures whether cookies are being set by the portal.',
                    'Provides timestamps for support tickets.',
                    'Helps diagnose if custom DNS is blocking the portal.',
                ],
            },
            {
                heading: 'Verify access afterward',
                paragraphs: [
                    'Reload the page to check that the scheme stays HTTP and the counters climb, indicating open internet.',
                ],
            },
        ],
        faqs: [
            {
                question: 'What if my loyalty perks do not apply?',
                answer:
                    'Share the header snapshot with the front desk so they can validate your room and plan selection.',
            },
        ],
    },
    {
        path: '/best-western-wifi-login',
        title: 'Best Western Wi-Fi login troubleshooting',
        description:
            'Force the Best Western guest Wi-Fi portal to load and capture diagnostics for hotel staff with nossl.sh.',
        keywords: 'best western wifi login, best western portal, hotel wifi help, best western internet',
        category: 'hotels',
        hero: 'Best Western Wi-Fi helper',
        tagline:
            'Use nossl.sh as your no-SSL landing page before calling the front desk.',
        sections: [
            {
                heading: 'Trigger the captive gate',
                paragraphs: [
                    'Open nossl.sh immediately after connecting so the Best Western gateway can show its sign-in prompt.',
                ],
                bullets: [
                    'Verifies IP assignment from the hotel network.',
                    'Lightweight for older laptops and budget phones.',
                    'Copyable diagnostics for regional support teams.',
                ],
            },
            {
                heading: 'If speeds stay slow',
                paragraphs: [
                    'Check the latency indicator and headers to see if you are still quarantined behind the splash page.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Can I test multiple devices?',
                answer:
                    'Yes. Open nossl.sh on each device to gather timestamps the hotel can use to whitelist MAC addresses.',
            },
        ],
    },
]);

export const SEO_PAGES_BY_CATEGORY = Object.freeze(
    Object.entries(SEO_PAGE_CATEGORIES)
        .map(([id, meta]) => ({
            id,
            ...meta,
            pages: SEO_PAGES.filter((page) => page.category === id),
        }))
        .filter((category) => category.pages.length > 0),
);

export const SEO_PAGE_PATH_SET = new Set(SEO_PAGES.map((page) => page.path));
