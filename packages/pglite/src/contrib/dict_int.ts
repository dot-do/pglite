import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/dict_int.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const dict_int = {
  name: 'dict_int',
  setup,
} satisfies Extension
