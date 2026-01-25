import * as fs from 'fs/promises'
import * as path from 'path'

async function findAndReplaceInFile(
  find: string | RegExp,
  replace: string,
  file: string,
): Promise<void> {
  const content = await fs.readFile(file, 'utf8')
  const replacedContent = content.replace(find, replace)
  await fs.writeFile(file, replacedContent)
}

async function findAndReplaceInDir(
  dir: string,
  find: string | RegExp,
  replace: string,
  extensions: string[],
  recursive = false,
): Promise<void> {
  const files = await fs.readdir(dir, { withFileTypes: true })

  for (const file of files) {
    const filePath = path.join(dir, file.name)
    if (file.isDirectory() && recursive) {
      await findAndReplaceInDir(filePath, find, replace, extensions)
    } else {
      const fileExt = path.extname(file.name)
      if (extensions.includes(fileExt)) {
        await findAndReplaceInFile(find, replace, filePath)
      }
    }
  }
}

const copyFiles = async (srcDir: string, destDir: string) => {
  await fs.mkdir(destDir, { recursive: true })
  const files = await fs.readdir(srcDir)
  for (const file of files) {
    if (file.startsWith('.')) {
      continue
    }
    const srcFile = path.join(srcDir, file)
    const destFile = path.join(destDir, file)
    const stat = await fs.stat(srcFile)
    if (stat.isFile()) {
      await fs.copyFile(srcFile, destFile)
      console.log(`Copied ${srcFile} to ${destFile}`)
    }
  }
}

async function patchForCloudflareWorkers() {
  console.log('Patching for Cloudflare Workers compatibility...')

  // Patch 1: Replace _scriptName = import.meta.url with empty string
  // import.meta.url is undefined in Cloudflare Workers
  await findAndReplaceInDir(
    './dist',
    /var _scriptName\s*=\s*import\.meta\.url;?/g,
    'var _scriptName = "";',
    ['.js'],
  )
  console.log('  Patched _scriptName')

  // Patch 2: Add caches check to ENVIRONMENT_IS_NODE detection
  // Workers have globalThis.caches, Node.js doesn't
  await findAndReplaceInDir(
    './dist',
    /process\.type!="renderer"/g,
    'process.type!="renderer"&&typeof globalThis.caches==="undefined"',
    ['.js', '.cjs'],
  )
  console.log('  Patched ENVIRONMENT_IS_NODE detection')

  // Patch 3: Guard the Node.js module import with caches check
  await findAndReplaceInDir(
    './dist',
    /if\(ENVIRONMENT_IS_NODE\)\{const\{createRequire\}/g,
    'if(ENVIRONMENT_IS_NODE && typeof globalThis.caches === "undefined"){const{createRequire}',
    ['.js', '.cjs'],
  )
  console.log('  Patched Node.js module import guard')

  // Patch 4: Replace dirname = import.meta.url with "/"
  await findAndReplaceInDir(
    './dist',
    /let dirname=import\.meta\.url/g,
    'let dirname="/"',
    ['.js'],
  )
  console.log('  Patched dirname import.meta.url')

  // Patch 5: Replace import.meta.url.startsWith patterns
  await findAndReplaceInDir(
    './dist',
    /import\.meta\.url\.startsWith/g,
    '("").startsWith',
    ['.js'],
  )

  // Patch 6: Replace remaining import.meta.url with empty string
  await findAndReplaceInDir(
    './dist',
    /import\.meta\.url/g,
    '""',
    ['.js'],
  )
  console.log('  Patched remaining import.meta.url references')

  // Patch 7: Replace new URL(..., "") patterns from earlier patches
  await findAndReplaceInDir(
    './dist',
    /new URL\("pglite\.wasm",""\)\.href/g,
    '"pglite.wasm"',
    ['.js', '.cjs'],
  )
  await findAndReplaceInDir(
    './dist',
    /new URL\("pglite\.data",""\)\.href/g,
    '"pglite.data"',
    ['.js', '.cjs'],
  )
  console.log('  Patched new URL patterns')

  // Patch 8: Add caches check to isNode variable detection
  await findAndReplaceInDir(
    './dist',
    /var isNode=typeof process==="object"&&typeof process\.versions==="object"&&typeof process\.versions\.node==="string"/g,
    'var isNode=typeof process==="object"&&typeof process.versions==="object"&&typeof process.versions.node==="string"&&typeof globalThis.caches==="undefined"',
    ['.js', '.cjs'],
  )
  console.log('  Patched isNode variable detection')

  // Patch 9: Add caches check to if(isNode) conditionals
  await findAndReplaceInDir(
    './dist',
    /if\(isNode\)\{/g,
    'if(isNode && typeof globalThis.caches === "undefined"){',
    ['.js', '.cjs'],
  )
  console.log('  Patched if(isNode) conditionals')

  // Patch 10: Guard self.location.href access (may be undefined in Durable Objects)
  await findAndReplaceInDir(
    './dist',
    /scriptDirectory=self\.location\.href/g,
    'scriptDirectory=(self.location&&self.location.href)||""',
    ['.js', '.cjs'],
  )
  console.log('  Patched self.location.href access')

  console.log('Cloudflare Workers patches applied successfully')
}

async function main() {
  await copyFiles('./release', './dist')
  await findAndReplaceInDir('./dist', /\.\.\/release\//g, './', ['.js', '.cjs'])

  // Apply Cloudflare Workers compatibility patches
  await patchForCloudflareWorkers()

  await findAndReplaceInDir('./dist/contrib', /\.\.\/release\//g, '', [
    '.js',
    '.cjs',
  ])
  await findAndReplaceInDir('./dist/vector', /\.\.\/release\//g, '', [
    '.js',
    '.cjs',
  ])
  await findAndReplaceInDir('./dist/pg_ivm', /\.\.\/release\//g, '', [
    '.js',
    '.cjs',
  ])
  await findAndReplaceInDir('./dist/pgtap', /\.\.\/release\//g, '', [
    '.js',
    '.cjs',
  ])
  await findAndReplaceInDir('./dist/pg_uuidv7', /\.\.\/release\//g, '', [
    '.js',
    '.cjs',
  ])
  await findAndReplaceInDir(
    './dist',
    `require("./postgres.js")`,
    `require("./postgres.cjs").default`,
    ['.cjs'],
  )
  await findAndReplaceInDir('./dist/pg_hashids', /\.\.\/release\//g, '', ['.js', '.cjs'])
}

await main()
