import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, emscriptenOpts: any) => {
  return {
    emscriptenOpts,
    bundlePath: new URL('../../release/pg_hashids.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pg_hashids = {
  name: 'pg_hashids',
  setup,
} satisfies Extension
