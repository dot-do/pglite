import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, emscriptenOpts: any) => {
  return {
    emscriptenOpts,
    bundlePath: new URL('../../release/pg_ivm.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pg_ivm = {
  name: 'pg_ivm',
  setup,
} satisfies Extension
