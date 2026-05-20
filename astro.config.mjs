// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Canonical production URL. Makes context.site available to the RSS feed +
  // JSON API endpoints (v0.8 PR3) so they can emit absolute links.
  site: 'https://oncbrain.oncologytoolkit.com',
});
