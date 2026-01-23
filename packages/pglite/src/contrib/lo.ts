import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/lo.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const lo = {
  name: 'lo',
  setup,
} satisfies Extension
