import { redact, REDACTED, scanForCredentials } from "../../src/lib/redactor";

// The `cookie` rule was the last one in the table with no value test at all:
//
//     /(Set-)?Cookie:\s*[^\r\n]+/gi
//
// It fires on the literal text "cookie:" and then swallows the rest of the line.
// Nothing in it asks whether a cookie is actually being set, so under
// `block_on_detect` egress an English sentence containing the word "cookie:" is a
// refused document. Measured over the real vault (2094 notes) before this file was
// written: 23 hits across 6 notes, and NOT ONE of them was a cookie value.
//
//   `Cookie: ml_access, ml_refresh`     two cookie NAMES, no value anywhere
//   `Cookie: ml_access=`                a name, an equals, and nothing
//   `Set-Cookie: ml_refresh=;`          the same, with the delimiter
//   `Set-Cookie: ml_session=...`        an elision
//   `Cookie: ml_access=${token}`        a shell reference in a curl example
//   `Cookie: ml_oauth_state={nonce}`    a placeholder
//   `Cookie: ml_access=EXPIRED`         a state label in an ASCII sequence diagram
//   `3. Set cookie:   |`                a diagram cell that says the words
//   `cookie: page fires 200 ...`        prose, mid-sentence
//   "the `Cookie:` pattern eats ..."    this rule's own source, quoted in a proposal
//
// Sixteen of those 23 lines are the ASCII sequence diagrams in
// `20260217-console-auth.md`, which is exactly the document you would want governed
// when you ask "how does console auth work". It was refused for drawing a picture of
// a cookie.
//
// Two structural facts about RFC 6265 do the whole job, and neither needs a word list:
//
//   1. A header is `name=value` pairs. `Cookie: a, b` sets nothing, and neither does
//      the word "cookie:" in a sentence. Requiring `name=` immediately after the colon
//      (or, for a request header, anywhere in the line) removes every prose hit.
//   2. `Set-Cookie` carries exactly ONE pair; everything after the first `;` is an
//      attribute (`Path=/`, `Max-Age=1209600`, `SameSite=Lax`). Attributes are
//      grammar, never secrets, so the Set-Cookie form tests its FIRST pair only. A
//      request `Cookie:` header has no attributes, so there every pair is a real
//      value and any one of them firing is enough.
//
// The value itself then has to be credential-SHAPED, and that test already exists in
// this table: it is the one the `bearer` rule uses (a digit or base64 `=` padding, or
// mixed case), widened by `_` and `%` because cookie values carry both. Diagram
// labels fail it the same way prose does: `EXPIRED` is one case, `ml_at_xxx` is one
// case, `T` is neither long nor mixed.
const REAL_HEADERS: Array<[string, string]> = [
  ["a hex session id", "Cookie: id=a3f9c2d1e0b8"],
  ["an opaque prefixed token", "Cookie: ml_access=ml_at_9f8e7d6c5b4a3f2e1d0c"],
  ["base64 with no digits", "Cookie: __Host-session=Zm9vYmFyYmF6cXV4"],
  ["a percent-encoded value", "Cookie: enc=YWJjOmRlZg%3D%3D"],
  ["a lowercase header name", "set-cookie: SID=dQw4w9WgXcQ"],
  ["a screaming header name", "SET-COOKIE: s=AAAA1111BBBB2222"],
  ["a tab after the colon", "Cookie:\tsid=9f8e7d6c"],
  ["a value in a LATER pair", "Cookie: theme=dark; session=Zm9vYmFyYmF6cXV4"],
  ["a real value plus attributes", "Set-Cookie: session=abc123; HttpOnly; Path=/"],
];

// Every one of these is a shape lifted from the vault. `redact` must leave them
// byte-identical and `scanForCredentials` must stay silent, because under
// `block_on_detect` a single id here refuses the whole document.
const NOT_HEADERS: Array<[string, string]> = [
  ["a list of cookie names", "Cookie: ml_access, ml_refresh"],
  ["a list of names on Set-Cookie", "Set-Cookie: ml_access, ml_refresh"],
  ["an empty value", "Cookie: ml_access="],
  ["an empty value with a delimiter", "Set-Cookie: ml_refresh=;"],
  ["an elision", "Set-Cookie: ml_session=...; HttpOnly; Secure; SameSite=Lax"],
  ["an elision with a parenthetical", "Set-Cookie: ml_access=...(15min)"],
  ["a shell reference", '-H "Cookie: ml_access=${token}" \\'],
  ["a brace placeholder", "Cookie: ml_oauth_state={nonce}"],
  ["an angle placeholder", "Set-Cookie: ml_refresh=<jwt>; Path=/; Max-Age=1209600"],
  ["a shape placeholder", "Cookie: ml_access=ml_at_xxx"],
  ["a diagram state label", "Cookie: ml_access=EXPIRED"],
  ["a diagram state label on Set-Cookie", "Set-Cookie: ml_access=NEW"],
  ["a single-letter diagram value", "Cookie: ml_access=T"],
  ["a diagram cell that says the words", "3. Set cookie:   |"],
  ["the word mid-sentence", "cookie: page fires 200 and paints the usage feed"],
  ["a mermaid arrow", "B->>MW: GET /value (cookie: ml_refresh, ml_access expired)"],
  ["this rule quoted in a proposal", "a single `Cookie:` pattern eats the entire blob"],
];

describe("cookie: a header sets a value, a sentence does not", () => {
  it.each(REAL_HEADERS)("redacts %s", (_label, input) => {
    expect(redact(input)).toBe(REDACTED);
    expect(scanForCredentials(input)).toContain("cookie");
  });

  it.each(NOT_HEADERS)("leaves %s alone", (_label, input) => {
    expect(redact(input)).toBe(input);
    expect(scanForCredentials(input)).toEqual([]);
  });

  // The four planes agree on `redact` only, but this composition is what keeps the
  // narrowed rule honest: when a nested rule has already taken the value, the cookie
  // rule declines the leftovers instead of eating the header name, and the document
  // is still refused because the nested rule reported it.
  it("declines a value another rule already redacted, and that rule still reports it", () => {
    const jwtCookie =
      "Set-Cookie: ml_refresh=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ; HttpOnly";
    expect(redact(jwtCookie)).toBe(`Set-Cookie: ml_refresh=${REDACTED}; HttpOnly`);
    expect(scanForCredentials(jwtCookie)).toContain("jwt");
  });

  it("does not fire on its own output", () => {
    expect(redact(`Cookie: ml_access=${REDACTED}`)).toBe(`Cookie: ml_access=${REDACTED}`);
    expect(scanForCredentials(`Cookie: ml_access=${REDACTED}`)).toEqual([]);
  });

  // `Set-Cookie` contains `Cookie:`, so the request-header form has to refuse to
  // match inside it. Without that, the looser "any pair in the line" scan would read
  // a Set-Cookie ATTRIBUTE as a value and re-admit every elision above.
  it("does not read a Set-Cookie attribute as a request-cookie value", () => {
    const attributesOnly = "Set-Cookie: ml_session=...; Max-Age=1209600; SameSite=Lax";
    expect(redact(attributesOnly)).toBe(attributesOnly);
    expect(scanForCredentials(attributesOnly)).toEqual([]);
  });

  // `\s` crosses newlines, so the old rule could match a header on one line and
  // redact the FIRST LINE OF THE NEXT PARAGRAPH as its value.
  it("does not reach across a newline for its value", () => {
    const wrapped = "Cookie:\nsession=abc123def456";
    expect(redact(wrapped)).toBe(wrapped);
  });
});
