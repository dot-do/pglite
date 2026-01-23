import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/pageinspect.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pageinspect = {
  name: 'pageinspect',
  setup,
} satisfies Extension
