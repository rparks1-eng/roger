/** Native dialog provides focus containment, Escape and inert background behavior. */
export function createCustomizationDrawer({ dialog, trigger, closeButton, render }) {
  let opener;
  function open() {
    if (dialog.open) return;
    opener = dialog.ownerDocument.activeElement;
    render();
    dialog.showModal();
    trigger?.setAttribute('aria-expanded', 'true');
    closeButton.focus();
  }
  function close() {
    if (dialog.open) dialog.close();
  }
  const restore = () => {
    trigger?.setAttribute('aria-expanded', 'false');
    if (opener?.isConnected) opener.focus();
  };
  const backdrop = (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      close();
  };
  trigger?.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', restore);
  dialog.addEventListener('click', backdrop);
  return {
    open,
    close,
    destroy() {
      close();
      trigger?.removeEventListener('click', open);
      closeButton.removeEventListener('click', close);
      dialog.removeEventListener('close', restore);
      dialog.removeEventListener('click', backdrop);
    },
  };
}
