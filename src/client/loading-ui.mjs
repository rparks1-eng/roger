export function skeleton(layout) {
  const placeholder = document.createElement('div');
  placeholder.className = `loading-shape loading-shape--${layout}`;
  placeholder.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 3; index++) placeholder.append(document.createElement('span'));
  return placeholder;
}
