const DEFAULT_MAX_PARAM_LENGTH = 8000;

export const MAX_HTML_PARAM_LENGTH = DEFAULT_MAX_PARAM_LENGTH;

export const encodeHtmlParam = (html: string): string => {
  const bytes = new TextEncoder().encode(html);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const decodeHtmlParam = (param: string): string => {
  let base64 = param.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = base64.length % 4;
  if (padLength) {
    base64 = base64.padEnd(base64.length + (4 - padLength), '=');
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export const wrapHtmlDocument = (html: string): string => {
  if (/<html[\s>]/i.test(html) || /<!doctype/i.test(html)) {
    return html;
  }
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nebula HTML Output</title>
    <style>
      body { margin: 0; padding: 24px; font-family: system-ui, -apple-system, sans-serif; }
    </style>
  </head>
  <body>
    ${html}
  </body>
</html>`;
};
