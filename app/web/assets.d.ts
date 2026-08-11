/**
 * The browser bundle imports one stylesheet, and TypeScript has to be told that is a
 * thing (E5-0, #80). Vite turns a `.css` side-effect import into a `<link>` in the built
 * page; `tsc` knows nothing about that and refuses the import without this.
 *
 * A side-effect import only — there is no `styles.button` object to reach for, because
 * there are no CSS modules here. `chrome.css` is one stylesheet, extracted from the
 * mockups, and the class names in it are the ones the mockups already agreed on.
 */
declare module '*.css'
