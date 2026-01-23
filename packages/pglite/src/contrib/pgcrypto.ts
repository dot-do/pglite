import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/pgcrypto.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pgcrypto = {
  name: 'pgcrypto',
  setup,
} satisfies Extension
