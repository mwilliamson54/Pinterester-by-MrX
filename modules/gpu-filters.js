/**
 * BulkyGen WebGL GPU Filters
 * Raw WebGL 1.0 implementation of micro-perturbations.
 * No wrappers. Linear color space. Manual clamping.
 */
(function() {
    'use strict';

    const TAG = 'GPUFilters';
    const log = () => globalThis.bulkygenLogger;

    const VS_SOURCE = `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;
        varying vec2 v_texCoord;
        void main() {
            gl_Position = vec4(a_position, 0.0, 1.0);
            v_texCoord = a_texCoord;
        }
    `;

    const FS_SOURCE = `
        precision highp float;
        varying vec2 v_texCoord;
        uniform sampler2D u_image;
        uniform float u_time;
        uniform vec2 u_resolution;

        // Configs
        uniform float u_grainStrength;
        uniform float u_blueNoiseStrength;
        uniform float u_rgbVariation;
        uniform float u_luminanceVariation;
        uniform float u_quantization;

        // High precision pseudo-random
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        // Gaussian noise approximation
        float gaussianNoise(vec2 uv) {
            float r1 = hash(uv + u_time);
            float r2 = hash(uv - u_time);
            return sqrt(-2.0 * log(r1 + 0.00001)) * cos(6.2831853 * r2);
        }

        // sRGB to Linear
        vec3 srgbToLinear(vec3 c) {
            vec3 low = c / 12.92;
            vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
            return mix(high, low, step(c, vec3(0.04045)));
        }

        // Linear to sRGB
        vec3 linearToSrgb(vec3 c) {
            vec3 low = c * 12.92;
            vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
            return mix(high, low, step(c, vec3(0.0031308)));
        }

        void main() {
            vec4 texColor = texture2D(u_image, v_texCoord);
            vec3 linearColor = srgbToLinear(texColor.rgb);

            vec2 uv = v_texCoord * u_resolution;

            // 1. Sensor Grain (Luminance dominant)
            if (u_grainStrength > 0.0) {
                float grain = gaussianNoise(uv) * u_grainStrength * 0.0078; // scaled to stay within ~2 RGB levels
                linearColor += grain;
            }

            // 2. Blue Noise approximation (high freq spatial hash)
            if (u_blueNoiseStrength > 0.0) {
                float bn = (hash(uv * 100.0 + u_time) - 0.5) * u_blueNoiseStrength * 0.0078;
                linearColor += bn;
            }

            // 3. RGB Variation
            if (u_rgbVariation > 0.0) {
                float r = (hash(uv + vec2(1.0, u_time)) - 0.5) * u_rgbVariation * 0.0078;
                float g = (hash(uv + vec2(2.0, u_time)) - 0.5) * u_rgbVariation * 0.0078;
                float b = (hash(uv + vec2(3.0, u_time)) - 0.5) * u_rgbVariation * 0.0078;
                linearColor += vec3(r, g, b);
            }

            // 4. Subpixel Luminance (brightness only)
            if (u_luminanceVariation > 0.0) {
                float lum = (hash(uv + vec2(u_time, 4.0)) - 0.5) * u_luminanceVariation * 0.0078;
                linearColor += vec3(lum);
            }

            // 5. Stochastic Quantization
            if (u_quantization > 0.0) {
                float steps = 255.0; // 8-bit
                float dither = (hash(uv + vec2(5.0, u_time)) - 0.5) / steps;
                linearColor = floor((linearColor + dither) * steps + 0.5) / steps;
            }

            // Clamp manually to 0-1 before sRGB conversion
            linearColor = clamp(linearColor, 0.0, 1.0);
            
            vec3 finalColor = linearToSrgb(linearColor);
            
            // Final manual clamp just to be absolutely certain
            finalColor = clamp(finalColor, 0.0, 1.0);

            gl_FragColor = vec4(finalColor, texColor.a);
        }
    `;

    function createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error('Shader compilation error: ' + info);
        }
        return shader;
    }

    function createProgram(gl, vsSource, fsSource) {
        const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
        const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(prog);
            gl.deleteProgram(prog);
            throw new Error('Program linking error: ' + info);
        }
        return prog;
    }

    /**
     * Applies WebGL filters to an ImageBitmap and returns an ImageBitmap
     */
    async function applyFilters(sourceBitmap, profile) {
        const width = sourceBitmap.width;
        const height = sourceBitmap.height;
        
        const canvas = new OffscreenCanvas(width, height);
        const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: false });
        if (!gl) {
            throw new Error('WebGL 1.0 not supported');
        }

        gl.viewport(0, 0, width, height);

        const program = createProgram(gl, VS_SOURCE, FS_SOURCE);
        gl.useProgram(program);

        // Setup geometry
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
            -1,  1,
             1, -1,
             1,  1
        ]), gl.STATIC_DRAW);
        const posLoc = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        const texBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 1,
            1, 1,
            0, 0,
            0, 0,
            1, 1,
            1, 0
        ]), gl.STATIC_DRAW);
        const texLoc = gl.getAttribLocation(program, 'a_texCoord');
        gl.enableVertexAttribArray(texLoc);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

        // Setup texture
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceBitmap);

        // Set uniforms
        const setFloat = (name, val) => gl.uniform1f(gl.getUniformLocation(program, name), val);
        
        gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), width, height);
        setFloat('u_time', Math.random() * 100.0);
        
        // Profiles
        const p = profile || {};
        setFloat('u_grainStrength', p.sensor_grain?.enabled ? (p.sensor_grain.strength || 0.35) : 0.0);
        setFloat('u_blueNoiseStrength', p.blue_noise?.enabled ? (p.blue_noise.strength || 0.20) : 0.0);
        setFloat('u_rgbVariation', p.rgb_variation?.enabled ? 1.0 : 0.0);
        setFloat('u_luminanceVariation', p.luminance_variation?.enabled ? 1.0 : 0.0);
        setFloat('u_quantization', p.stochastic_quantization?.enabled ? 1.0 : 0.0);

        // Draw
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Cleanup
        gl.deleteTexture(texture);
        gl.deleteBuffer(posBuffer);
        gl.deleteBuffer(texBuffer);
        gl.deleteProgram(program);

        // Return processed bitmap
        return await createImageBitmap(canvas);
    }

    globalThis.bulkygenGpuFilters = {
        applyFilters
    };
})();
