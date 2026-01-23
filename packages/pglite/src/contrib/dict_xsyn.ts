import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/dict_xsyn.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const dict_xsyn = {
  name: 'dict_xsyn',
  setup,
} satisfies Extension
