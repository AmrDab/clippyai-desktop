import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-governor-'));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmp } }));

import { classifyRisk, classifyLabel, classifyUrl, classifyKeys } from '../src/main/governor';
import { classFor, decide, setPolicy } from '../src/main/permission-policy';

const click = (target: string) => classifyRisk({ tool: 'smart_click', args: { target } });

describe('classifyLabel — positives', () => {
  it.each([
    ['Place order', 'destructive_purchase'],
    ['Place your order', 'destructive_purchase'],
    ['Buy now', 'destructive_purchase'],
    ['Pay $12.99', 'destructive_purchase'],
    ['Checkout', 'destructive_purchase'],
    ['Check out', 'destructive_purchase'],
    ['Confirm payment', 'destructive_purchase'],
    ['Complete purchase', 'destructive_purchase'],
    ['Transfer', 'destructive_purchase'],
    ['Book now', 'destructive_purchase'],
    ['Send', 'destructive_send'],
    ['SEND', 'destructive_send'],
    ['Submit', 'destructive_send'],
    ['Submit feedback', 'destructive_send'],
    ['Reply all', 'destructive_send'],
    ['Publish', 'share_public'],
    ['Post', 'share_public'],
    ['Delete', 'destructive_file'],
    ['Remove', 'destructive_file'],
    ['Empty trash', 'destructive_file'],
    ['Uninstall', 'destructive_file'],
    ['Subscribe', 'destructive_web'],
    ['Confirm', 'destructive_exec'],
    ['Authorize', 'destructive_exec'],
  ])('%s → %s', (label, cls) => {
    const v = click(label);
    expect(v?.class).toBe(cls);
    expect(v?.reason).toContain(label);
  });

  it('normalises selectors: #place-order-btn reads as "place order"', () => {
    expect(classifyRisk({ tool: 'cdp_click', args: { selector: '#place-order-btn' } })?.class).toBe('destructive_purchase');
    expect(classifyRisk({ tool: 'browser_click', args: { text: 'Send' } })?.class).toBe('destructive_send');
  });

  it('is word-bounded', () => {
    expect(classifyLabel('Sender')).toBeNull();      // not "send"
    expect(classifyLabel('Deleted Items')).toBeNull(); // not "delete"
    expect(classifyLabel('Payable')).toBeNull();
    expect(classifyLabel('Postpone')).toBeNull();
  });
});

describe('classifyLabel — negatives / exclusions', () => {
  it.each([
    'Continue', 'Next', 'OK', 'Apply filters', 'Search', 'Cancel', 'Open', 'Save',
    'Add to cart', 'Payment methods', 'Payment history', 'Remove filters', 'Remove formatting',
    'Order history', 'My orders', 'Sort order', 'Address Book', 'Trash', 'Posts',
    'Transfer files', 'Format painter', 'Confirmation email', 'Terminal', 'Bookings',
  ])('%s is benign', (label) => {
    expect(click(label)).toBeNull();
  });

  it('ignores tools it does not govern', () => {
    expect(classifyRisk({ tool: 'read_screen', args: { target: 'Place order' } })).toBeNull();
    expect(classifyRisk({ tool: 'mouse_hover', args: {} })).toBeNull();
  });
});

describe('classifyUrl', () => {
  it.each([
    'https://www.amazon.com/gp/buy/spc/handlers/checkout',
    'https://shop.example.com/checkout',
    'https://shop.example.com/cart?step=2',
    'https://app.example.com/billing/',
    'https://checkout.stripe.com/c/pay/cs_test_123',
    'https://www.paypal.com/checkout/review',
    'https://www.paypal.com/cgi-bin/webscr?cmd=_express-checkout',
  ])('%s is a purchase surface', (url) => {
    expect(classifyUrl(url)?.class).toBe('destructive_purchase');
  });

  it.each([
    'https://mail.google.com/mail/u/0/#inbox?compose=new',
    'https://outlook.live.com/mail/0/deeplink/compose',
    'https://app.example.com/messages/compose',
  ])('%s is a compose surface', (url) => {
    expect(classifyUrl(url)?.class).toBe('destructive_send');
  });

  it.each([
    'https://www.example.com/',
    'https://mail.google.com/mail/u/0/#inbox',
    'https://docs.google.com/document/d/abc/edit',
    'https://shop.example.com/products/cart-wheels',
    'https://github.com/foo/checkout-action',
  ])('%s is benign', (url) => {
    expect(classifyUrl(url)).toBeNull();
  });

  it('escalates a click on a checkout page even with a benign label', () => {
    const v = classifyRisk({ tool: 'cdp_click', args: { text: 'Continue' }, url: 'https://shop.example.com/checkout' });
    expect(v?.class).toBe('destructive_purchase');
  });

  it('does not escalate typing on a checkout page', () => {
    expect(classifyRisk({ tool: 'cdp_type', args: { label: 'Street address', text: '1 Main St' }, url: 'https://shop.example.com/checkout' })).toBeNull();
  });
});

describe('classifyKeys', () => {
  it.each(['alt+f4', 'Alt+F4', 'ctrl+alt+del', 'ctrl+alt+delete', 'cmd+q', 'command+q', 'cmd+shift+q', 'cmd+alt+esc', 'cmd+option+esc'])(
    '%s is risky', (keys) => {
      expect(classifyKeys(keys)?.class).toBe('destructive_exec');
      expect(classifyRisk({ tool: 'key_press', args: { key: keys } })?.class).toBe('destructive_exec');
    });

  it.each(['ctrl+s', 'cmd+c', 'Tab', 'Escape', 'alt+tab', 'ctrl+z', 'F5'])('%s is benign', (keys) => {
    expect(classifyRisk({ tool: 'key_press', args: { key: keys } })).toBeNull();
  });

  it('bare Enter is not escalated without context', () => {
    expect(classifyRisk({ tool: 'key_press', args: { key: 'Enter' } })).toBeNull();
    expect(classifyRisk({ tool: 'key_press', args: { key: 'ctrl+enter' } })).toBeNull();
    expect(classifyRisk({ tool: 'key_press', args: { key: 'Return' }, context: 'Inbox - Gmail' })).toBeNull();
  });

  it('Enter escalates in a compose or checkout context', () => {
    expect(classifyRisk({ tool: 'key_press', args: { key: 'Enter' }, context: 'New Message - Outlook' })?.class).toBe('destructive_send');
    expect(classifyRisk({ tool: 'key_press', args: { key: 'ctrl+enter' }, context: 'Untitled - Message (HTML)' })?.class).toBe('destructive_send');
    expect(classifyRisk({ tool: 'key_press', args: { key: 'Return' }, url: 'https://shop.example.com/checkout' })?.class).toBe('destructive_purchase');
  });

  it('type_text ending in a newline behaves like Enter', () => {
    expect(classifyRisk({ tool: 'type_text', args: { text: 'hello\n' } })).toBeNull();
    expect(classifyRisk({ tool: 'type_text', args: { text: 'hello\n' }, context: 'Compose - Mail' })?.class).toBe('destructive_send');
    expect(classifyRisk({ tool: 'type_text', args: { text: 'hello' }, context: 'Compose - Mail' })).toBeNull();
  });
});

describe('coordinate clicks + credential fields', () => {
  it('mouse_click escalates from a checkout window title', () => {
    expect(classifyRisk({ tool: 'mouse_click', args: { x: 1, y: 2 }, context: 'Checkout - Amazon.com - Google Chrome' })?.class).toBe('destructive_purchase');
    expect(classifyRisk({ tool: 'mouse_click', args: { x: 1, y: 2 }, context: 'Document1 - Word' })).toBeNull();
    expect(classifyRisk({ tool: 'mouse_click', args: { x: 1, y: 2 } })).toBeNull();
  });

  it('typing into a password / card field escalates', () => {
    expect(classifyRisk({ tool: 'smart_type', args: { target: 'Password', text: 'x' } })?.class).toBe('destructive_send');
    expect(classifyRisk({ tool: 'cdp_type', args: { selector: '#cvv', text: '123' } })?.class).toBe('destructive_send');
    expect(classifyRisk({ tool: 'smart_type', args: { target: 'Search', text: 'x' } })).toBeNull();
  });
});

describe('integration with permission-policy', () => {
  beforeEach(() => { setPolicy({ mode: 'standard', classOverrides: {} }); });

  it('classFor/decide honour the escalated class', () => {
    expect(classFor('smart_click', { target: 'Continue' })).toBe('desktop_input');
    expect(decide('smart_click', { target: 'Continue' })).toBe('allow');
    const risk = click('Place order')!;
    expect(classFor('smart_click', { target: 'Place order' }, risk.class)).toBe('destructive_purchase');
    expect(decide('smart_click', { target: 'Place order' }, risk.class)).toBe('approve');
  });

  it('standard: escalated send/delete ask; trusted: only purchase asks; cautious: everything asks', () => {
    const send = click('Send')!.class;
    const del = click('Delete')!.class;
    const buy = click('Buy now')!.class;
    expect(decide('smart_click', {}, send)).toBe('approve');
    expect(decide('smart_click', {}, del)).toBe('approve');
    setPolicy({ mode: 'trusted' });
    expect(decide('smart_click', {}, buy)).toBe('approve');
    expect(decide('smart_click', {}, send)).toBe('allow');
    expect(decide('smart_click', {}, del)).toBe('allow');
    setPolicy({ mode: 'cautious' });
    expect(decide('smart_click', {}, send)).toBe('approve');
    expect(decide('smart_click', {})).toBe('approve');
  });

  it('per-class overrides apply to the escalated class', () => {
    setPolicy({ mode: 'trusted', classOverrides: { destructive_purchase: 'block' } });
    expect(decide('smart_click', { target: 'Place order' }, click('Place order')!.class)).toBe('block');
  });
});
