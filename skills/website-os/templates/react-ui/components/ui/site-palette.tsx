"use client";
import {useState} from 'react';
import {Button, ColorArea, ColorField, ColorSlider, ColorSwatch, ColorSwatchPicker, Label, parseColor} from '@heroui/react';
import {ChevronDown, RotateCcw, Shuffle} from 'lucide-react';
import {ColorPicker} from '@/components/ui/heroui-color-picker';

export type PaletteField = {id: string; label: string; value: string; original: string};
export type PaletteProps = {fields: PaletteField[]; onChange: (id: string, value: string) => void};
const presets = ['#e5e4e0', '#1d1d1d', '#f1f0ec', '#252525', '#c9d8bd', '#a9c4d5', '#dbb8a5', '#b9add0', '#ffffff'];

function PaletteColor({field, onChange}: {field: PaletteField; onChange: PaletteProps['onChange']}) {
  const [color, setColor] = useState(() => parseColor(field.value));
  const change = (next: ReturnType<typeof parseColor>) => {setColor(next); onChange(field.id, next.toString('hex'));};
  return <ColorPicker value={color} onChange={change}>
    <ColorPicker.Trigger className="wos-palette-trigger" aria-label={`Edit ${field.label} colour`}>
      <ColorSwatch size="lg"/>
      <span className="wos-palette-label"><Label>{field.label}</Label><small>{color.toString('hex').toUpperCase()}</small></span>
      <ChevronDown size={13} color="#939888" aria-hidden="true"/>
    </ColorPicker.Trigger>
    <ColorPicker.Popover className="wos-color-popover" placement="left top">
      <div className="wos-picker-heading">{field.label}<span>LIVE PREVIEW</span></div>
      <ColorArea aria-label={`${field.label} saturation and brightness`} colorSpace="hsb" xChannel="saturation" yChannel="brightness"><ColorArea.Thumb/></ColorArea>
      <div className="flex items-center gap-2">
        <ColorSlider aria-label={`${field.label} hue`} channel="hue" className="flex-1" colorSpace="hsb"><ColorSlider.Track><ColorSlider.Thumb/></ColorSlider.Track></ColorSlider>
        <Button isIconOnly aria-label={`Shuffle ${field.label} colour`} size="sm" variant="tertiary" onPress={() => change(parseColor(`hsl(${Math.floor(Math.random()*360)}, 30%, 75%)`))}><Shuffle size={14}/></Button>
      </div>
      <ColorField aria-label={`${field.label} hex colour`}><ColorField.Group variant="secondary"><ColorField.Prefix><ColorSwatch size="xs"/></ColorField.Prefix><ColorField.Input/></ColorField.Group></ColorField>
      <ColorSwatchPicker aria-label={`${field.label} colour presets`} size="xs">{presets.map(preset => <ColorSwatchPicker.Item key={preset} color={preset}><ColorSwatchPicker.Swatch/></ColorSwatchPicker.Item>)}</ColorSwatchPicker>
      <button type="button" className="wos-palette-reset" onClick={() => change(parseColor(field.original))}><RotateCcw size={11}/> Back to saved colour</button>
    </ColorPicker.Popover>
  </ColorPicker>;
}
export function SitePalette({fields, onChange}: PaletteProps) {
  return <div className="wos-palette">{fields.map(field => <PaletteColor key={field.id} field={field} onChange={onChange}/>)}</div>;
}
