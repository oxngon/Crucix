// Serialise a value for safe embedding inside an inline <script> element.
//
// JSON.stringify leaves `<`, `>` and `/` untouched, so a string value that
// contains `</script` terminates the element at the HTML tokenizer and the
// remainder of the value is parsed as document markup — a stored script
// injection whenever the value came from a third-party feed.
//
// `\/` is a valid escape inside a JavaScript string literal, so escaping the
// slash leaves the value unchanged when evaluated while guaranteeing the byte
// sequence `</script` never appears in the served document.
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/<\/(script)/gi, '<\\/$1');
}