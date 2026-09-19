import { clipboard } from 'electron'
import { extractUrls, extractUrlsFromHtml, unique } from '../shared/urls'

export function readClipboardUrls(): string[] {
  const fromText = extractUrls(clipboard.readText())
  const fromHtml = extractUrlsFromHtml(clipboard.readHTML())
  let fromBookmark: string[] = []
  try {
    const bookmark = clipboard.readBookmark()
    if (bookmark?.url) fromBookmark = extractUrls(bookmark.url)
  } catch {
    fromBookmark = []
  }
  return unique([...fromText, ...fromHtml, ...fromBookmark])
}
