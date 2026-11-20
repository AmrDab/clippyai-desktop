import { describe, it, expect } from 'vitest';
import { reportUiaClick, outcomeLine } from '../src/main/click-report';

const base = { name: 'High', controlType: 'ListItem', method: 'uia-select', pending: false };

describe('outcomeLine', () => {
  it('confirmed | unverified · hint | failed · CODE · hint', () => {
    expect(outcomeLine('confirmed')).toBe('[confirmed]');
    expect(outcomeLine('unverified', undefined, 'read_screen to check')).toBe('[unverified · read_screen to check]');
    expect(outcomeLine('failed', 'DID_NOTHING', 'use mouse_click')).toBe('[failed · DID_NOTHING · use mouse_click]');
  });
});

describe('reportUiaClick', () => {
  it('the WinForms combo box failure: a classic list item gets a real click, never "via UIA Select"', () => {
    const r = reportUiaClick('High', { ...base, method: 'uia-coords', classic: true, before: '', after: '(gone)', gone: true,
      changed: ['a popup closed', 'focus: ComboBox "Priority" = "High"', '"High" is gone'] });
    expect(r.text.split('\n')).toEqual([
      'Clicked "High" with a real click (classic control, UIA patterns skipped) (ListItem "High")',
      'Changed: a popup closed; focus: ComboBox "Priority" = "High"; "High" is gone',
      '[unverified · the screen changed as listed; read_screen if the result matters]',
    ]);
    expect(r.status).toBe('unverified');
  });

  it('Select read back as selected is confirmed', () => {
    const r = reportUiaClick('High', { ...base, before: '', after: 'selected', changed: ['"High": (no state) -> selected'] });
    expect(r.text).toMatch(/^Clicked "High" via UIA Select \(ListItem "High"\): now selected\nChanged: .*\n\[confirmed\]$/);
    expect(r.status).toBe('verified');
  });

  it('Select that left it unselected is DID_NOTHING, not a success', () => {
    const r = reportUiaClick('High', { ...base, before: '', after: '', changed: [] });
    expect(r).toMatchObject({ status: 'error', code: 'DID_NOTHING' });
    expect(r.text).toMatch(/but it is still not selected\n\[failed · DID_NOTHING · /);
  });

  it('Toggle: the new state is read back', () => {
    const cb = { name: 'Remember me', controlType: 'CheckBox', method: 'uia-toggle' };
    const ok = reportUiaClick('Remember me', { ...cb, before: 'unchecked', after: 'checked', changed: ['"Remember me": unchecked -> checked'] });
    expect(ok.text).toMatch(/^Clicked "Remember me" via UIA Toggle \(CheckBox "Remember me"\): now checked\n/);
    expect(ok.text.endsWith('[confirmed]')).toBe(true);
    expect(ok.status).toBe('verified');
    const no = reportUiaClick('Remember me', { ...cb, before: 'unchecked', after: 'unchecked', changed: [] });
    expect(no.text).toMatch(/, but it is still unchecked\n\[failed · DID_NOTHING · /);
    expect(no.status).toBe('error');
  });

  it('Invoke is never confirmed: unverified, with or without visible change', () => {
    const btn = { name: 'Save', controlType: 'Button', method: 'uia-invoke' };
    const changed = reportUiaClick('Save', { ...btn, before: '', after: '', changed: ['window "Save As" opened'] });
    expect(changed.text).toBe('Clicked "Save" via UIA Invoke (Button "Save")\nChanged: window "Save As" opened\n[unverified · the screen changed as listed; read_screen if the result matters]');
    const none = reportUiaClick('Save', { ...btn, before: '', after: '', changed: [] });
    expect(none.text).toBe('Clicked "Save" via UIA Invoke (Button "Save")\n[unverified · NO_VISIBLE_CHANGE · nothing visible changed; read_screen to check before going on]');
    expect(changed.status).toBe('unverified');
    expect(none.status).toBe('unverified');
  });

  it('a control that went away after the click is not a failure', () => {
    const r = reportUiaClick('High', { ...base, before: '', after: '(gone)', gone: true, changed: ['"High" is gone'] });
    expect(r.status).toBe('unverified');
  });

  it('pending (a modal dialog is up) and a result with no read-back stay unverified', () => {
    expect(reportUiaClick('Open', { name: 'Open', controlType: 'Button', method: 'uia-invoke', pending: true, changed: ['window "Open" opened'] }).text)
      .toMatch(/the app is still handling it \(a dialog may have opened\)\nChanged: window "Open" opened\n\[unverified · read_screen to see what opened\]$/);
    expect(reportUiaClick('Send', { name: 'Send', controlType: 'Button', method: 'uia-invoke' }).text)
      .toBe('Clicked "Send" via UIA Invoke (Button "Send")\n[unverified · read_screen to check]');
  });
});
