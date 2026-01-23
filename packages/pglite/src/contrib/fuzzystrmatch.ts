import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/fuzzystrmatch.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const fuzzystrmatch = {
  name: 'fuzzystrmatch',
  setup,
} satisfies Extension
