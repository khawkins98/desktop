/* eslint-disable no-sync */

import * as cp from 'child_process'
import { createReadStream } from 'fs'
import { writeFile } from 'fs/promises'
import { pathExists, chmod } from 'fs-extra'
import * as path from 'path'
import * as electronInstaller from 'electron-winstaller'
import * as crypto from 'crypto'

import { getProductName, getCompanyName } from '../app/package-info'
import {
  getDistPath,
  getOSXZipPath,
  getWindowsIdentifierName,
  getWindowsStandaloneName,
  getWindowsInstallerName,
  shouldMakeDelta,
  getUpdatesURL,
  getIconFileName,
  isPublishable,
  getBundleSizes,
  getDistRoot,
  getDistArchitecture,
} from './dist-info'
import { isGitHubActions } from './build-platforms'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { getVersion } from '../app/package-info'
import { rename } from 'fs/promises'
import { join } from 'path'

import { packageElectronBuilder } from './package-electron-builder'
import { packageDebian } from './package-debian'
import { packageRedhat } from './package-redhat'

const distPath = getDistPath()
const productName = getProductName()
const outputDir = getDistRoot()

if (process.platform === 'darwin') {
  packageOSX()
} else if (process.platform === 'win32') {
  packageWindows()
} else if (process.platform === 'linux') {
  packageLinux()
} else {
  console.error(`I don't know how to package for ${process.platform} :(`)
  process.exit(1)
}

console.log('Writing bundle size info…')
writeFileSync(
  path.join(getDistRoot(), 'bundle-size.json'),
  JSON.stringify(getBundleSizes())
)

function packageOSX() {
  const dest = getOSXZipPath()
  rmSync(dest, { recursive: true, force: true })

  console.log('Packaging for macOS…')
  cp.execSync(
    `ditto -ck --keepParent "${distPath}/${productName}.app" "${dest}"`
  )
}

function packageWindows() {
  const iconSource = path.join(
    __dirname,
    '..',
    'app',
    'static',
    'logos',
    `${getIconFileName()}.ico`
  )

  if (!existsSync(iconSource)) {
    console.error(`expected setup icon not found at location: ${iconSource}`)
    process.exit(1)
  }

  const splashScreenPath = path.resolve(
    __dirname,
    '../app/static/logos/win32-installer-splash.gif'
  )

  if (!existsSync(splashScreenPath)) {
    console.error(
      `expected setup splash screen gif not found at location: ${splashScreenPath}`
    )
    process.exit(1)
  }

  const iconUrl =
    'https://desktop.githubusercontent.com/github-desktop/app-icon.ico'

  const nugetPkgName = getWindowsIdentifierName()
  const options: electronInstaller.Options = {
    name: nugetPkgName,
    appDirectory: distPath,
    outputDirectory: outputDir,
    authors: getCompanyName(),
    iconUrl: iconUrl,
    setupIcon: iconSource,
    loadingGif: splashScreenPath,
    exe: `${nugetPkgName}.exe`,
    title: productName,
    setupExe: getWindowsStandaloneName(),
    setupMsi: getWindowsInstallerName(),
  }

  if (shouldMakeDelta()) {
    const url = new URL(getUpdatesURL())
    // Make sure Squirrel.Windows isn't affected by partially or completely
    // disabled releases.
    url.searchParams.set('bypassStaggeredRelease', '1')
    options.remoteReleases = url.toString()
  }

  if (isGitHubActions() && isPublishable()) {
    const certificatePath = path.join(__dirname, 'windows-certificate.pfx')
    options.signWithParams = `/f ${certificatePath} /p ${process.env.WINDOWS_CERT_PASSWORD} /tr http://timestamp.digicert.com /td sha256 /fd sha256`
  }

  console.log('Packaging for Windows…')
  electronInstaller
    .createWindowsInstaller(options)
    .then(() => console.log(`Installers created in ${outputDir}`))
    .then(async () => {
      // electron-winstaller (more specifically Squirrel.Windows) doesn't let
      // us control the name of the nuget packages but we want them to include
      // the architecture similar to how the setup exe and msi do so we'll just
      // have to rename them here after the fact.
      const arch = getDistArchitecture()
      const prefix = `${getWindowsIdentifierName()}-${getVersion()}`

      for (const kind of shouldMakeDelta() ? ['full', 'delta'] : ['full']) {
        const from = join(outputDir, `${prefix}-${kind}.nupkg`)
        const to = join(outputDir, `${prefix}-${arch}-${kind}.nupkg`)

        console.log(`Renaming ${from} to ${to}`)
        await rename(from, to)
      }
    })
    .catch(e => {
      console.error(`Error packaging: ${e}`)
      process.exit(1)
    })
}

function getSha256Checksum(fullPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const algo = 'sha256'
    const shasum = crypto.createHash(algo)

    const s = createReadStream(fullPath)
    s.on('data', function (d) {
      shasum.update(d)
    })
    s.on('error', err => {
      reject(err)
    })
    s.on('end', function () {
      const d = shasum.digest('hex')
      resolve(d)
    })
  })
}

async function generateChecksums(files: Array<string>) {
  const distRoot = getDistRoot()

  const checksums = new Map<string, string>()

  for (const f of files) {
    const checksum = await getSha256Checksum(f)
    checksums.set(f, checksum)
  }

  let checksumsText = `Checksums: \n`

  for (const [fullPath, checksum] of checksums) {
    const fileName = path.basename(fullPath)
    checksumsText += `${checksum} - ${fileName}\n`

    const checksumFilePath = `${fullPath}.sha256`
    await writeFile(checksumFilePath, checksum)
  }

  const checksumFile = path.join(distRoot, 'checksums.txt')

  await writeFile(checksumFile, checksumsText)
}

async function packageLinux() {
  const helperPath = path.join(getDistPath(), 'chrome-sandbox')
  const exists = await pathExists(helperPath)

  if (exists) {
    console.log('Updating file mode for chrome-sandbox…')
    await chmod(helperPath, 0o4755)
  }
  try {
    const files = await packageElectronBuilder()
    const debianPackage = await packageDebian()
    const redhatPackage = await packageRedhat()

    const installers = [...files, debianPackage, redhatPackage]

    console.log(`Installers created:`)
    for (const installer of installers) {
      console.log(` - ${installer}`)
    }

    generateChecksums(installers)
  } catch (err) {
    console.error('A problem occurred with the packaging step', err)
    process.exit(1)
  }
}
