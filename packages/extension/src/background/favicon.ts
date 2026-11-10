/**
 * The favicon the side panel may show for a tab. Only inline `data:image/…` icons qualify: an
 * https favicon displayed in an extension page is a network request to that site, while the
 * extension talks only to the local daemon (privacy policy, Store disclosures). Chrome's `favicon`
 * permission would serve icons from its local cache, but it adds the install warning "Read the icons
 * of the websites you visit" (D-022). Other tabs get a generic icon. Pure.
 */
export function localFavicon(url: string | undefined): string {
  return url !== undefined && url.startsWith('data:image/') ? url : ''
}
