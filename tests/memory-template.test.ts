import { describe, it, expect } from 'vitest';
import { stripHtmlComments } from '../src/main/profile';

describe('MEMORY.md template comments are not memories', () => {
  it('drops bullets inside <!-- --> blocks, keeps real ones', () => {
    const md = [
      '# Memory',
      '<!--',
      '- User prefers Apple Mail over web mail',
      '- Quiet hours: 23:00-08:00 local.',
      '-->',
      '- Likes green tea',
      '<!-- - inline example --> ',
      '<!-- unclosed',
      '- never a memory',
    ].join('\n');
    const out = stripHtmlComments(md).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));
    expect(out).toEqual(['- Likes green tea']);
  });
});
