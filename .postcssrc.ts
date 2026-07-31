import { capraTokenPostcssPlugin } from '@capra/dx-tokens-postcss-plugin'
import { allTokens } from '@capra/theme/dx/tokens-minimal'

export default {
  plugins: [capraTokenPostcssPlugin({ tokens: allTokens })],
}
