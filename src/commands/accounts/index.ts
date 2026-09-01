import type { Command } from '../../commands.js'

const accounts = {
  type: 'local-jsx',
  name: 'accounts',
  description: 'Manage Antigravity Google accounts',
  load: () => import('./accounts.js'),
} satisfies Command

export default accounts
