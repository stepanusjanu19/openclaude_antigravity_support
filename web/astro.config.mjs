import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://openclaude.gitlawb.com',
  trailingSlash: 'always',
  redirects: {
    '/changelog/': 'https://github.com/stepanusjanu19/openclaude_antigravity_support/releases',
  },
  integrations: [sitemap()],
})
