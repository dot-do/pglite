import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/tablefunc.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const tablefunc = {
  name: 'tablefunc',
  setup,
} satisfies Extension
