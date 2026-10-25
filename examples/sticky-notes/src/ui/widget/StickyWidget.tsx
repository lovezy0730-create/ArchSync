/** 常驻桌面的便签小窗。 */
export function StickyWidget(props: { noteId: string; body: string; alwaysOnTop: boolean }) {
  return (
    <div className={`sticky-widget ${props.alwaysOnTop ? 'top' : ''}`} data-note-id={props.noteId}>
      <div className="widget-body">{props.body}</div>
    </div>
  );
}
