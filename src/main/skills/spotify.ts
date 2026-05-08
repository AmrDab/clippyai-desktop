/**
 * Spotify convenience tool: play URIs via deep-link
 */

import { openUrl } from './openurl';
import type { ToolResult } from '../types/tool-result';

export async function spotifyPlayUri(params: Record<string, unknown>): Promise<ToolResult> {
  const uri = String(params.uri || '');

  if (!uri.startsWith('spotify:')) {
    return { text: '(error:INVALID_SPOTIFY_URI) uri must start with spotify:' };
  }

  const hasType = ['track:', 'album:', 'playlist:', 'artist:'].some((t) => uri.includes(t));
  if (!hasType) {
    return { text: '(error:INVALID_SPOTIFY_URI) uri must contain track:, album:, playlist:, or artist:' };
  }

  return openUrl({ url: uri });
}
