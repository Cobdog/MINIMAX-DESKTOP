/** Labeled form primitives shared by the Create and Settings views. */
import { useId } from 'react'
import { ChevronDown } from 'lucide-react'

export function SelectField({ label, value, options, onChange, disabled }: { label: string; value: string; options: string[][]; onChange(value: string): void; disabled?: boolean }) {
  const id = useId()
  return <div className="field-group"><label htmlFor={id}>{label}</label><div className="select-wrap"><select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option value={optionValue} key={optionValue}>{text}</option>)}</select><ChevronDown size={15} /></div></div>
}

export function NumberField({ label, value, min, max, step, onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void; disabled?: boolean }) {
  return <div className="field-group"><label>{label}</label><input className="number-input" type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></div>
}
