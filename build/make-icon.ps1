# Dessine l'icône de Sonde (512 x 512) d'après la maquette : carré arrondi
# dégradé violet -> magenta -> rose, radar blanc (deux pistes, faisceau, point).
# Usage : powershell -File build\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$S = 512; $k = $S / 64   # la maquette est dessinée sur 64 unités
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

function RoundRect($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90); $p.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
  $p.AddArc($x + $w - 2 * $r, $y + $h - 2 * $r, 2 * $r, 2 * $r, 0, 90); $p.AddArc($x, $y + $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $p.CloseFigure(); return $p
}
$c = { param($a, $r, $gg, $b) [System.Drawing.Color]::FromArgb($a, $r, $gg, $b) }

# Fond : dégradé à trois couleurs
$shape = RoundRect (2 * $k) (2 * $k) (60 * $k) (60 * $k) (16 * $k)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $S, $S), (& $c 255 124 92 255), (& $c 255 255 95 162)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend 3
$blend.Colors = @((& $c 255 124 92 255), (& $c 255 196 85 255), (& $c 255 255 95 162))
$blend.Positions = @(0.0, 0.55, 1.0)
$grad.InterpolationColors = $blend
$g.FillPath($grad, $shape)

# Reflet en haut à gauche
$glare = New-Object System.Drawing.Drawing2D.PathGradientBrush $shape
$glare.CenterPoint = New-Object System.Drawing.PointF ($S * .3), ($S * .2)
$glare.CenterColor = & $c 90 255 255 255
$glare.SurroundColors = @(& $c 0 255 255 255)
$g.FillPath($glare, $shape)

# Radar : deux pistes, le faisceau, le centre et le point allumé
$white = { param($a, $w) New-Object System.Drawing.Pen (& $c $a 255 255 255), ($w * $k) }
$g.DrawEllipse((& $white 230 3.2), (13 * $k), (13 * $k), (38 * $k), (38 * $k))
$g.DrawEllipse((& $white 140 3.2), (22 * $k), (22 * $k), (20 * $k), (20 * $k))
$beam = New-Object System.Drawing.SolidBrush (& $c 72 255 255 255)
$g.FillPie($beam, (13 * $k), (13 * $k), (38 * $k), (38 * $k), -90, 60)
$dot = New-Object System.Drawing.SolidBrush (& $c 255 255 255 255)
$g.FillEllipse($dot, (28.8 * $k), (28.8 * $k), (6.4 * $k), (6.4 * $k))
$g.FillEllipse($dot, (40.2 * $k), (13.4 * $k), (8 * $k), (8 * $k))

$out = Join-Path $PSScriptRoot 'icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"Icone ecrite : $out"
