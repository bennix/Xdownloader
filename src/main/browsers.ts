import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'

export type BrowserOption = {
  id: string
  label: string
  installed: boolean
  lastUsed: number
  version: string
  userAgent: string
  family: string
  appPath: string
}

type BrowserSpec = {
  id: string
  label: string
  family: 'chrome' | 'safari' | 'firefox' | 'edge' | 'brave' | 'opera' | 'vivaldi' | 'chromium'
  apps: string[]
  dataDir?: string
  cookieFiles?: string[]
  profiles?: boolean
}

const SPECS: BrowserSpec[] = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    family: 'chrome',
    apps: ['Google Chrome.app'],
    dataDir: join(homedir(), 'Library/Application Support/Google/Chrome'),
    profiles: true
  },
  {
    id: 'safari',
    label: 'Safari',
    family: 'safari',
    apps: ['Safari.app'],
    cookieFiles: [
      join(homedir(), 'Library/Cookies/Cookies.binarycookies'),
      join(homedir(), 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies')
    ]
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    family: 'edge',
    apps: ['Microsoft Edge.app'],
    dataDir: join(homedir(), 'Library/Application Support/Microsoft Edge'),
    profiles: true
  },
  {
    id: 'brave',
    label: 'Brave',
    family: 'brave',
    apps: ['Brave Browser.app'],
    dataDir: join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
    profiles: true
  },
  {
    id: 'firefox',
    label: 'Firefox',
    family: 'firefox',
    apps: ['Firefox.app'],
    dataDir: join(homedir(), 'Library/Application Support/Firefox/Profiles')
  },
  {
    id: 'arc',
    label: 'Arc',
    family: 'chrome',
    apps: ['Arc.app'],
    dataDir: join(homedir(), 'Library/Application Support/Arc/User Data'),
    profiles: true
  },
  {
    id: 'vivaldi',
    label: 'Vivaldi',
    family: 'vivaldi',
    apps: ['Vivaldi.app'],
    dataDir: join(homedir(), 'Library/Application Support/Vivaldi'),
    profiles: true
  },
  {
    id: 'opera',
    label: 'Opera',
    family: 'opera',
    apps: ['Opera.app'],
    dataDir: join(homedir(), 'Library/Application Support/com.operasoftware.Opera'),
    profiles: true
  },
  {
    id: 'chromium',
    label: 'Chromium',
    family: 'chromium',
    apps: ['Chromium.app'],
    dataDir: join(homedir(), 'Library/Application Support/Chromium'),
    profiles: true
  }
]

const APP_ROOTS = [
  '/Applications',
  join(homedir(), 'Applications'),
  '/System/Applications',
  '/System/Cryptexes/App/System/Applications'
]

let cached: BrowserOption[] = []
let cachedAt = 0

export function listBrowserOptions(): BrowserOption[] {
  const now = Date.now()
  if (cached.length && now - cachedAt < 30_000) return cached
  cached = scanBrowsers()
  cachedAt = now
  return cached
}

export function pickBestBrowser(options = listBrowserOptions()): BrowserOption | null {
  return options[0] ?? null
}

export function resolveCookiesArg(preference: string, options = listBrowserOptions()): string | null {
  if (!preference || preference === 'none') return null
  if (preference === 'auto') return pickBestBrowser(options)?.id ?? null
  if (
    options.some((item) => item.id === preference) ||
    /^(safari|chrome|brave|edge|firefox|opera|vivaldi|chromium|arc)/.test(preference)
  ) {
    return preference
  }
  return pickBestBrowser(options)?.id ?? preference
}

function scanBrowsers(): BrowserOption[] {
  try {
    const installed = listInstalledApps()
    const options: BrowserOption[] = []
    for (const spec of SPECS) {
      const appPath = resolveAppPath(spec, installed)
      if (!appPath && !hasBrowserData(spec)) continue
      const version = appPath ? appVersion(appPath) : ''
      const userAgent = buildUserAgent(spec.family, version)
      const profiles = spec.profiles ? readChromiumProfiles(spec, appPath || spec.apps[0], version, userAgent) : []
      if (profiles.length) {
        options.push(...profiles)
        continue
      }
      options.push({
        id: spec.id,
        label: version ? `${spec.label} ${version}` : spec.label,
        installed: true,
        lastUsed: latestMtime([spec.dataDir, ...(spec.cookieFiles ?? []), appPath]),
        version,
        userAgent,
        family: spec.family,
        appPath: appPath || ''
      })
    }
    return options.sort((a, b) => b.lastUsed - a.lastUsed)
  } catch {
    return cached
  }
}

function listInstalledApps(): Map<string, string> {
  const found = new Map<string, string>()
  for (const root of APP_ROOTS) {
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.app')) continue
      const full = join(root, name)
      if (!found.has(name) && existsSync(full)) found.set(name, full)
    }
  }
  return found
}

function resolveAppPath(spec: BrowserSpec, installed: Map<string, string>): string {
  for (const name of spec.apps) {
    const mapped = installed.get(name)
    if (mapped) return mapped
    for (const root of APP_ROOTS) {
      const full = join(root, name)
      if (existsSync(full)) return full
    }
  }
  return ''
}

function hasBrowserData(spec: BrowserSpec): boolean {
  if (spec.dataDir && existsSync(spec.dataDir)) return true
  return (spec.cookieFiles ?? []).some((file) => existsSync(file))
}

function readChromiumProfiles(spec: BrowserSpec, appPath: string, version: string, userAgent: string): BrowserOption[] {
  if (!spec.dataDir) return []
  const lastUsedName = readLastUsedProfile(spec.dataDir)
  const names = new Set<string>(['Default', ...listProfileDirs(spec.dataDir)])
  if (lastUsedName) names.add(lastUsedName)
  const found: BrowserOption[] = []
  for (const name of names) {
    const dir = join(spec.dataDir, name)
    const cookies = join(dir, 'Cookies')
    if (!existsSync(dir) && name !== 'Default') continue
    const profile = name === 'Default' ? spec.label : `${spec.label} · ${profileLabel(name)}`
    found.push({
      id: name === 'Default' ? spec.id : `${spec.id}:${name}`,
      label: version ? `${profile} ${version}` : profile,
      installed: true,
      lastUsed: latestMtime([cookies, dir, spec.dataDir]),
      version,
      userAgent,
      family: spec.family,
      appPath
    })
  }
  if (lastUsedName) {
    const preferred = found.find((item) => item.id === spec.id || item.id.endsWith(`:${lastUsedName}`))
    if (preferred) preferred.lastUsed = Date.now()
  }
  return found.length
    ? found
    : [
        {
          id: spec.id,
          label: version ? `${spec.label} ${version}` : spec.label,
          installed: true,
          lastUsed: latestMtime([spec.dataDir]),
          version,
          userAgent,
          family: spec.family,
          appPath
        }
      ]
}

function buildUserAgent(family: BrowserSpec['family'], version: string): string {
  const ver = version || defaultVersion(family)
  const mac = macToken()
  switch (family) {
    case 'safari':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${mac}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver} Safari/605.1.15`
    case 'firefox':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${mac.replaceAll('_', '.')}; rv:${ver}) Gecko/20100101 Firefox/${ver}`
    case 'edge':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${mac}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeCore(ver)} Safari/537.36 Edg/${ver}`
    case 'opera':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${mac}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeCore(ver)} Safari/537.36 OPR/${ver}`
    default:
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${mac}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
  }
}

function defaultVersion(family: BrowserSpec['family']): string {
  if (family === 'safari') return '18.0'
  if (family === 'firefox') return '133.0'
  return '131.0.0.0'
}

function chromeCore(version: string): string {
  const major = version.split('.')[0] || '131'
  return `${major}.0.0.0`
}

function macToken(): string {
  const darwin = release().split('.')[0]
  const mapped = Number(darwin) >= 20 ? String(Number(darwin) - 9) : '10'
  return mapped === '10' ? '10_15_7' : `${mapped}_0_0`
}

function appVersion(appPath: string): string {
  try {
    const raw = readFileSync(join(appPath, 'Contents/Info.plist'))
    const text = raw.toString('latin1')
    const xml = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
    if (xml?.[1]) return xml[1].trim()
    const idx = text.indexOf('CFBundleShortVersionString')
    if (idx < 0) return ''
    const slice = text.slice(idx, idx + 120)
    const ver = slice.match(/(\d+\.\d+(?:\.\d+){0,3})/)
    return ver?.[1] ?? ''
  } catch {
    return ''
  }
}

function readLastUsedProfile(dataDir: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'Local State'), 'utf8')) as {
      profile?: { last_used?: string }
    }
    return raw.profile?.last_used || ''
  } catch {
    return ''
  }
}

function listProfileDirs(dataDir: string): string[] {
  try {
    return readdirSync(dataDir).filter((name) => name === 'Default' || name.startsWith('Profile '))
  } catch {
    return []
  }
}

function profileLabel(name: string): string {
  return name === 'Default' ? '默认配置' : name.replace(/^Profile /, '配置 ')
}

function latestMtime(paths: (string | undefined)[]): number {
  let latest = 0
  for (const path of paths) {
    if (!path) continue
    try {
      latest = Math.max(latest, statSync(path).mtimeMs)
    } catch {
      /* TCC or missing */
    }
  }
  return latest
}
