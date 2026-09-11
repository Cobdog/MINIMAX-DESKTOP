/** StudioTabs — the studio's tab strips on top of Base UI Tabs.
 *
 *  Wave 2b: the mode tabs and the prompt-library tabs were plain button rows
 *  with role=tablist but no tab KEYBOARD semantics (no arrow-key navigation,
 *  no roving tabindex, every tab a Tab stop). Base UI supplies the behavior:
 *  ArrowLeft/ArrowRight/Home/End move and activate (automatic activation,
 *  activateOnFocus), only the selected tab holds a Tab stop, and aria
 *  tab/tablist wiring is real. The visual layer is untouched — the list
 *  carries the strip's class (e.g. `mode-tabs`) and each tab renders a real
 *  <button>, so the existing descendant selectors keep applying.
 */
import type { ReactNode } from 'react'
import { Tabs } from '@base-ui/react/tabs'

export type StudioTabsProps = {
  /** The active tab value (controlled). */
  value: string
  /** Called with the newly activated tab's value (click or arrow-key activation). */
  onChange(value: string): void
  /** The tab strip's class — the visual container (e.g. `mode-tabs`). */
  className: string
  /** Accessible name for the tab list. */
  'aria-label': string
  children: ReactNode
}

export function StudioTabs({ value, onChange, className, 'aria-label': ariaLabel, children }: StudioTabsProps) {
  return (
    <Tabs.Root value={value} onValueChange={(next) => { if (next !== value) onChange(next) }}>
      {/* Automatic activation: arrow keys move AND switch — selection follows
          focus (WAI-ARIA's recommendation for cheap, reversible tab switches,
          and the same instant behavior the click path always had). */}
      <Tabs.List className={className} aria-label={ariaLabel} activateOnFocus>{children}</Tabs.List>
    </Tabs.Root>
  )
}

export type StudioTabProps = {
  value: string
  /** Visual state class — pass the existing `selected` convention. */
  className?: string
  disabled?: boolean
  children: ReactNode
}

export function StudioTab({ value, className, disabled, children }: StudioTabProps) {
  return (
    <Tabs.Tab value={value} className={className} disabled={disabled}>{children}</Tabs.Tab>
  )
}
