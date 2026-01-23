import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/citext.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const citext = {
  name: 'citext',
  setup,
} satisfies Extension
