/** StudioDialog — the studio's modal layer on top of Base UI Dialog.
 *
 *  Wave 2b: the app's modals were hand-rolled — each carried its own (or no)
 *  focus trap, Escape handler and backdrop-click dismissal. This wrapper
 *  moves that BEHAVIOR to Base UI (focus trapping + restore, Escape, outside
 *  press, aria-modal wiring, scroll lock) while the studio's hand CSS stays
 *  the visual layer: the backdrop keeps `.modal-backdrop` (+ variants) and
 *  the popup keeps its own class untouched.
 *
 *  Geometry note: the legacy markup nested the popup inside the backdrop,
 *  which therefore owned the centering grid. Base UI portals Backdrop and
 *  Popup as siblings, so `.ui-dialog-center` (this module's extra div)
 *  carries the same inset/padding/centering for the popup.
 */
import type { ReactNode, RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'

export type StudioDialogProps = {
  /** Controlled open state. The portal (and focus trap) mount only while open. */
  open: boolean
  /** Called when the dialog should close (Escape, backdrop press, or imperative close). */
  onClose(): void
  /** Classes for the visual layers — every existing modal class keeps working. */
  backdropClassName?: string
  /** Extra class for the centering wrapper when a variant needs its own geometry
   *  (padding/z-index that the legacy backdrop variant used to carry). */
  centerClassName?: string
  /** The popup's own class (e.g. `source-media-modal`). */
  popupClassName: string
  /** id of the element whose text labels the dialog (aria-labelledby). */
  labelledBy?: string
  /** id of the element describing the dialog (aria-describedby). */
  describedBy?: string
  /** Element to focus when the dialog opens. Defaults to the first tabbable
   *  element inside the popup. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Element to return focus to when the dialog closes (the trigger). */
  finalFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}

export function StudioDialog({
  open, onClose, backdropClassName = '', centerClassName = '', popupClassName, labelledBy, describedBy, initialFocus, finalFocus, children,
}: StudioDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`modal-backdrop ${backdropClassName}`.trim()} />
        <div className={`ui-dialog-center ${centerClassName}`.trim()}>
          <Dialog.Popup
            render={<section aria-labelledby={labelledBy} aria-describedby={describedBy} />}
            className={popupClassName}
            initialFocus={initialFocus}
            finalFocus={finalFocus}
          >
            {children}
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
