// Vite's ?inline import: a stylesheet's text, for a page that carries its own CSS (a review's archive).
declare module '*.css?inline' {
  const css: string
  export default css
}
