import { defineConfig, devices } from '@playwright/test';

// The app is a client-rendered SPA (ssr=false); these tests mock every /api/*
// call via page.route, so no Odoo/Ably backend is needed. The dev server just
// serves the shell + client bundle.
export default defineConfig({
	testDir: './tests',
	timeout: 30000,
	expect: { timeout: 8000 },
	fullyParallel: false,
	use: {
		baseURL: 'http://localhost:4173',
		// the die/token pulse & bob animations loop forever; reduced-motion stops
		// them (via our CSS) so elements settle and are clickable/assertable.
		reducedMotion: 'reduce',
		trace: 'on-first-retry'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'npm run dev -- --port 4173 --strictPort',
		port: 4173,
		reuseExistingServer: true,
		timeout: 120000
	}
});
