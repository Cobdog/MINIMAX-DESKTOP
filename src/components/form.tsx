/** Labeled form primitives shared by the Create and Settings views. */
import { useId } from 'react'
import { ChevronDown } from 'lucide-react'

export function SelectField({ label, value, options, onChange, disabled }: { label: string; value: string; options: string[][]; onChange(value: string): void; disabled?: boolean }) {
  const id = useId()
  return <div className="field-group"><label htmlFor={id}>{label}</label><div className="select-wrap"><select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option value={optionValue} key={optionValue}>{text}</option>)}</select><ChevronDown size={15} /></div></div>
}

export function NumberField({ label, value, min, max, step, onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void; disabled?: boolean }) {
  // useId + htmlFor (SelectField's pattern; review minor 2026-09-19): an
  // id-less input fed the console's "form field without id/name" noise and
  // left the field unreachable by label for tests and assistive tech.
  const id = useId()
  return <div className="field-group"><label htmlFor={id}>{label}</label><input id={id} className="number-input" type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></div>
}
