import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasFromResponse, aliasRequest, cleanPrivacy, defaultPrivacy, dohServer, httpsUpgrade, isThirdParty } from '../src/shared/privacy.ts';
import { reduce, initialState, type Ctx } from '../src/shared/model.ts';

const ctx = (): Ctx => ({ now: 1_000, newId: () => 'x' });

test('privacy defaults are on and survive junk', () => {
  const d = defaultPrivacy();
  assert.equal(d.dns, 'quad9');
  assert.ok(d.gpc && d.thirdPartyCookies && d.httpsFirst);
  assert.equal(d.aliases.provider, 'none');
  const c = cleanPrivacy({ dns: 'evil', gpc: 'yes', thirdPartyCookies: false, aliases: { provider: 'relay', key: '  tok  ' }, dnsCustom: 'http://plain/dns' });
  assert.equal(c.dns, 'quad9');
  assert.equal(c.gpc, true);
  assert.equal(c.thirdPartyCookies, false);
  assert.deepEqual(c.aliases, { provider: 'relay', key: 'tok' });
  assert.equal(c.dnsCustom, undefined, 'a custom resolver must be https');
  assert.equal(cleanPrivacy({ dns: 'custom' }).dns, 'quad9', 'custom without a URL falls back');
  assert.equal(cleanPrivacy({ dns: 'custom', dnsCustom: 'https://doh.example/dns-query' }).dns, 'custom');
});

test('dohServer picks the resolver', () => {
  assert.equal(dohServer(defaultPrivacy()), 'https://dns.quad9.net/dns-query');
  assert.equal(dohServer({ ...defaultPrivacy(), dns: 'system' }), null);
  assert.equal(dohServer({ ...defaultPrivacy(), dns: 'custom', dnsCustom: 'https://doh.example/q' }), 'https://doh.example/q');
});

test('isThirdParty compares registrable domains', () => {
  assert.equal(isThirdParty('https://cdn.example.com/a.js', 'https://www.example.com/'), false);
  assert.equal(isThirdParty('https://tracker.net/p.gif', 'https://www.example.com/'), true);
  assert.equal(isThirdParty('https://a.co.uk/', 'https://b.co.uk/'), true);
  assert.equal(isThirdParty('https://x.test/', ''), false, 'no page known → leave it alone');
});

test('httpsUpgrade only touches plain public http pages', () => {
  assert.equal(httpsUpgrade('http://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(httpsUpgrade('http://example.com:80/'), 'https://example.com/');
  assert.equal(httpsUpgrade('https://example.com/'), null);
  assert.equal(httpsUpgrade('http://localhost:3000/'), null);
  assert.equal(httpsUpgrade('http://192.168.1.10/'), null);
  assert.equal(httpsUpgrade('http://nas.local/'), null);
  assert.equal(httpsUpgrade('http://example.com:8080/'), null, 'a custom port is a deliberate address');
  assert.equal(httpsUpgrade('chord://settings/'), null);
});

test('alias requests and answers for both services', () => {
  const sl = aliasRequest('simplelogin', 'KEY', 'shop.example')!;
  assert.match(sl.url, /^https:\/\/app\.simplelogin\.io\/api\/alias\/random\/new\?hostname=shop\.example$/);
  assert.equal(sl.init.headers.Authentication, 'KEY');
  const fr = aliasRequest('relay', 'TOK', 'shop.example')!;
  assert.equal(fr.url, 'https://relay.firefox.com/api/v1/relayaddresses/');
  assert.equal(fr.init.headers.Authorization, 'Token TOK');
  assert.equal(JSON.parse(fr.init.body!).generated_for, 'shop.example');
  assert.equal(aliasRequest('none', 'x', 'h'), null);
  assert.equal(aliasRequest('relay', '', 'h'), null);
  assert.equal(aliasFromResponse('simplelogin', { alias: 'a.b@slmail.me' }), 'a.b@slmail.me');
  assert.equal(aliasFromResponse('relay', { full_address: 'xyz@mozmail.com' }), 'xyz@mozmail.com');
  assert.equal(aliasFromResponse('relay', { full_address: 'not an address' }), null);
  assert.equal(aliasFromResponse('simplelogin', null), null);
});

test('settings.update cleans the privacy block', () => {
  let s = initialState(ctx());
  assert.equal(s.settings.privacy.dns, 'quad9');
  s = reduce(s, { type: 'settings.update', patch: { privacy: { dns: 'system', gpc: false, thirdPartyCookies: true, httpsFirst: true, aliases: { provider: 'bogus' as 'none' } } } }, ctx());
  assert.equal(s.settings.privacy.dns, 'system');
  assert.equal(s.settings.privacy.gpc, false);
  assert.equal(s.settings.privacy.aliases.provider, 'none');
});
