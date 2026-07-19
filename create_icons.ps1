Add-Type -AssemblyName System.Drawing

$sizes = @(16, 32, 48, 128)
$iconDir = "c:\Users\TUF\extension\icons"

foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    
    # Enable anti-aliasing
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    
    # Black background with rounded corners (simplified to rectangle)
    $blackBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
    $graphics.FillRectangle($blackBrush, 0, 0, $size, $size)
    
    # White fire/flame shape (simplified)
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, ($size / 32))
    
    # Draw flame shape
    $centerX = $size / 2
    $centerY = $size / 2
    $flameSize = $size * 0.6
    
    # Main flame body (ellipse)
    $graphics.FillEllipse($whiteBrush, ($centerX - $flameSize/3), ($centerY - $flameSize/2), ($flameSize * 0.66), $flameSize)
    
    # Draw "F" letter for Firefly
    $font = New-Object System.Drawing.Font("Arial", ($size * 0.4), [System.Drawing.FontStyle]::Bold)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    
    # Draw F in black on white background
    $blackBrush2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
    $graphics.DrawString("F", $font, $blackBrush2, $centerX, $centerY, $format)
    
    # Save
    $outputPath = Join-Path $iconDir "icon$size.png"
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    
    # Cleanup
    $graphics.Dispose()
    $bitmap.Dispose()
    $whiteBrush.Dispose()
    $whitePen.Dispose()
    $blackBrush.Dispose()
    $blackBrush2.Dispose()
    $font.Dispose()
    
    Write-Host "Created icon: $outputPath"
}

Write-Host "All icons created successfully!"
