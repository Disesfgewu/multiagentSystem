// A command can be run by any code in the editor with any argument. When the extension's own tree
// view runs a menu action, VS Code passes the very tree item object this extension created. Those
// objects are recorded here, so a command can tell "the person clicked this row" apart from "some
// caller passed `{ id }`". A plain object, or a copy of a row, is never recorded.

const ownItems = new WeakSet<object>();

/** Records a tree item created by this extension. Returns the item. */
export function markOwnUiItem<T extends object>(item: T): T {
  ownItems.add(item);
  return item;
}

/** True only for an object this extension recorded with `markOwnUiItem`. */
export function isOwnUiItem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && ownItems.has(value);
}
