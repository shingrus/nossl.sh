export const SEO_PAGES = Object.freeze([
    {
        path: '/what-is-nossl',
        title: 'What is nossl.sh? Plain HTTP captive portal helper',
        description:
            'Understand how nossl.sh provides a modern plain HTTP landing page to trigger captive portals and verify restrictive Wi-Fi networks.',
        keywords:
            'what is nossl, nossl explained, plain http landing page, captive portal helper',
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
        title: 'NeverSSL alternative for captive portal sign-in pages',
        description:
            'Discover a privacy-friendly alternative to NeverSSL that works on phones, laptops, travel routers, and embedded devices.',
        keywords:
            'neverssl alternative, neverssl replacement, captive portal alternative, wifi login helper',
        hero: 'Need a NeverSSL alternative?',
        tagline:
            'nossl.sh delivers the same behavior with refreshed diagnostics, uptime monitoring, and honeypot analytics.',
        sections: [
            {
                heading: 'Compatible with modern devices',
                paragraphs: [
                    'Whether you are onboarding a console, e-reader, or enterprise IoT sensor, nossl.sh provides the unsecured handshake captive portals expect.',
                ],
                bullets: [
                    'Loads quickly on low-power browsers.',
                    'No ads, trackers, or heavy assets.',
                    'Content security tuned for kiosk and mobile browsers.',
                ],
            },
            {
                heading: 'Visibility you will not find on the default splash page',
                paragraphs: [
                    'Compare your headers between attempts, or watch the cumulative SEO landing counter climb as teammates verify access in the field.',
                ],
                bullets: [
                    'Plain text IP response when using curl.',
                    'One-click copy of diagnostic headers for support tickets.',
                    'Honeypot stats to show how automated scanners probe captive networks.',
                ],
            },
        ],
        faqs: [
            {
                question: 'Does nossl.sh support HTTPS?',
                answer:
                    'The primary experience is HTTP, but HTTPS is also available for people who want to preview the layout securely.',
            },
            {
                question: 'How often is the service online?',
                answer:
                    'The project is monitored and designed to stay available 24/7 for travelers and operations teams.',
            },
        ],
    },
    {
        path: '/wifi-login-page',
        title: 'Wi-Fi login page tester for captive networks',
        description:
            'Use nossl.sh to force Wi-Fi login pages to appear, confirm captive portal redirects, and capture the headers your hardware sends.',
        keywords: 'wifi login page, captive wifi test, wifi splash page, network onboarding',
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
]);

export const SEO_PAGE_PATH_SET = new Set(SEO_PAGES.map((page) => page.path));
