"use client"

import {Button, ColorArea, ColorField, ColorSlider, ColorSwatch, ColorSwatchPicker, Label, parseColor} from "@heroui/react";
import {ColorPicker} from "@/components/ui/heroui-color-picker";
import {Shuffle} from "lucide-react";
import {useState} from "react";

export function Controlled() {
  const [color, setColor] = useState(parseColor("#325578"));
  const colorPresets = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e"];
  const shuffleColor = () => {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 50 + Math.floor(Math.random() * 50);
    const lightness = 40 + Math.floor(Math.random() * 30);
    setColor(parseColor(`hsl(${hue}, ${saturation}%, ${lightness}%)`));
  };
  return <div className="flex flex-col gap-4">
    <ColorPicker value={color} onChange={setColor}>
      <ColorPicker.Trigger><ColorSwatch size="lg"/><Label>Pick a color</Label></ColorPicker.Trigger>
      <ColorPicker.Popover className="gap-2">
        <ColorSwatchPicker className="justify-center pt-2" size="xs">
          {colorPresets.map(preset => <ColorSwatchPicker.Item key={preset} color={preset}><ColorSwatchPicker.Swatch/></ColorSwatchPicker.Item>)}
        </ColorSwatchPicker>
        <ColorArea aria-label="Color area" className="max-w-full" colorSpace="hsb" xChannel="saturation" yChannel="brightness"><ColorArea.Thumb/></ColorArea>
        <div className="flex items-center gap-2 px-1">
          <ColorSlider aria-label="Hue slider" channel="hue" className="flex-1" colorSpace="hsb"><ColorSlider.Track><ColorSlider.Thumb/></ColorSlider.Track></ColorSlider>
          <Button isIconOnly aria-label="Shuffle color" size="sm" variant="tertiary" onPress={shuffleColor}><Shuffle className="size-4"/></Button>
        </div>
        <ColorField aria-label="Color field"><ColorField.Group variant="secondary"><ColorField.Prefix><ColorSwatch size="xs"/></ColorField.Prefix><ColorField.Input/></ColorField.Group></ColorField>
      </ColorPicker.Popover>
    </ColorPicker>
    <p className="w-60 text-sm text-muted">Selected: <span className="font-medium">{color.toString("hex")}</span></p>
  </div>;
}
export default Controlled;
