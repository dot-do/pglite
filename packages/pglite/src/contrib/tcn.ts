import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/tcn.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const tcn = {
  name: 'tcn',
  setup,
} satisfies Extension
