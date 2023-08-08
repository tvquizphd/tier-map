/**
 * @module ol/layer/WebGLTile
 */
import BaseTileLayer from 'ol/layer/BaseTile.js';
import LayerProperty from 'ol/layer/Property.js';
import WebGLTileLayerRenderer, {
  Attributes,
  Uniforms,
} from 'ol/renderer/webgl/TileLayer.js';
import {
  PALETTE_TEXTURE_ARRAY,
  ValueTypes,
  expressionToGlsl,
  getStringNumberEquivalent,
  uniformNameForVariable,
} from 'ol/style/expressions.js';

/**
 * @typedef {Object} Options
 * @property {Style} [style] Style to apply to the layer.
 * @property {SourceType} [source] Source for this layer.
 * @property {number} [cacheSize=512] The internal texture cache size.  This needs to be large enough to render
 * two zoom levels worth of tiles.
 */

/**
 * @param {Style} style The layer style.
 * @param {number} [bandCount] The number of bands.
 * @return {ParsedStyle} Shaders and uniforms generated from the style.
 */
function parseStyle(style, bandCount) {
  const vertexShader = `
    attribute vec2 ${Attributes.TEXTURE_COORD};
    uniform mat4 ${Uniforms.TILE_TRANSFORM};
    uniform float ${Uniforms.TEXTURE_PIXEL_WIDTH};
    uniform float ${Uniforms.TEXTURE_PIXEL_HEIGHT};
    uniform float ${Uniforms.TEXTURE_RESOLUTION};
    uniform float ${Uniforms.TEXTURE_ORIGIN_X};
    uniform float ${Uniforms.TEXTURE_ORIGIN_Y};
    uniform float ${Uniforms.DEPTH};

    varying vec2 v_textureCoord;
    varying vec2 v_mapCoord;

    void main() {
      v_textureCoord = ${Attributes.TEXTURE_COORD};
      v_mapCoord = vec2(
        ${Uniforms.TEXTURE_ORIGIN_X} + ${Uniforms.TEXTURE_RESOLUTION} * ${Uniforms.TEXTURE_PIXEL_WIDTH} * v_textureCoord[0],
        ${Uniforms.TEXTURE_ORIGIN_Y} - ${Uniforms.TEXTURE_RESOLUTION} * ${Uniforms.TEXTURE_PIXEL_HEIGHT} * v_textureCoord[1]
      );
      gl_Position = ${Uniforms.TILE_TRANSFORM} * vec4(${Attributes.TEXTURE_COORD}, ${Uniforms.DEPTH}, 1.0);
    }
  `;

  /**
   * @type {import("../style/expressions.js").ParsingContext}
   */
  const context = {
    inFragmentShader: true,
    variables: [],
    attributes: [],
    stringLiteralsMap: {},
    functions: {},
    bandCount: bandCount,
    style: style,
  };

  const pipeline = [];

  if (style.color !== undefined) {
    const color = expressionToGlsl(context, style.color, ValueTypes.COLOR);
    pipeline.push(`
      float a = color.a;
      float not_a = 1. - a;
      color.rgb = ${color}.rgb * not_a + color.rgb * a;
      color.a = 1.;
    `);
  }

  /** @type {Object<string,import("../webgl/Helper").UniformValue>} */
  const uniforms = {};

  const numVariables = context.variables.length;
  if (numVariables > 1 && !style.variables) {
    throw new Error(
      `Missing variables in style (expected ${context.variables})`
    );
  }

  for (let i = 0; i < numVariables; ++i) {
    const variable = context.variables[i];
    if (!(variable.name in style.variables)) {
      throw new Error(`Missing '${variable.name}' in style variables`);
    }
    const uniformName = uniformNameForVariable(variable.name);
    uniforms[uniformName] = function () {
      let value = style.variables[variable.name];
      if (typeof value === 'string') {
        value = getStringNumberEquivalent(context, value);
      }
      return value !== undefined ? value : -9999999; // to avoid matching with the first string literal
    };
  }

  const uniformDeclarations = Object.keys(uniforms).map(function (name) {
    return `uniform float ${name};`;
  });

  const textureCount = Math.ceil(bandCount / 4);
  uniformDeclarations.push(
    `uniform sampler2D ${Uniforms.TILE_TEXTURE_ARRAY}[${textureCount}];`
  );

  if (context.paletteTextures) {
    uniformDeclarations.push(
      `uniform sampler2D ${PALETTE_TEXTURE_ARRAY}[${context.paletteTextures.length}];`
    );
  }

  const functionDefintions = Object.keys(context.functions).map(function (
    name
  ) {
    return context.functions[name];
  });

  const fragmentShader = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    varying vec2 v_textureCoord;
    varying vec2 v_mapCoord;
    uniform vec4 ${Uniforms.RENDER_EXTENT};
    uniform float ${Uniforms.TRANSITION_ALPHA};
    uniform float ${Uniforms.TEXTURE_PIXEL_WIDTH};
    uniform float ${Uniforms.TEXTURE_PIXEL_HEIGHT};
    uniform float ${Uniforms.RESOLUTION};
    uniform float ${Uniforms.ZOOM};

    ${uniformDeclarations.join('\n')}

    ${functionDefintions.join('\n')}

    void main() {
      if (
        v_mapCoord[0] < ${Uniforms.RENDER_EXTENT}[0] ||
        v_mapCoord[1] < ${Uniforms.RENDER_EXTENT}[1] ||
        v_mapCoord[0] > ${Uniforms.RENDER_EXTENT}[2] ||
        v_mapCoord[1] > ${Uniforms.RENDER_EXTENT}[3]
      ) {
        discard;
      }

      vec4 color = texture2D(${
        Uniforms.TILE_TEXTURE_ARRAY
      }[0],  v_textureCoord);

      ${pipeline.join('\n')}

      if (color.a == 0.0) {
        discard;
      }

      gl_FragColor = color;
      gl_FragColor.rgb *= gl_FragColor.a;
      gl_FragColor *= ${Uniforms.TRANSITION_ALPHA};
    }`;

  return {
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    uniforms: uniforms,
    paletteTextures: context.paletteTextures,
  };
}

/**
 * @classdesc
 *
 * @extends BaseTileLayer<SourceType, WebGLTileLayerRenderer>
 * @fires import("../render/Event.js").RenderEvent
 */
class WebGLTileLayer extends BaseTileLayer {
  /**
   * @param {Options} options Tile layer options.
   */
  constructor(options) {
    options = options ? Object.assign({}, options) : {};

    const style = options.style || {};
    delete options.style;

    const cacheSize = options.cacheSize;
    delete options.cacheSize;

    super(options);

    /**
     * @type {Array<SourceType>|function(import("../extent.js").Extent, number):Array<SourceType>}
     * @private
     */
    this.sources_ = options.sources;

    /**
     * @type {SourceType|null}
     * @private
     */
    this.renderedSource_ = null;

    /**
     * @type {number}
     * @private
     */
    this.renderedResolution_ = NaN;

    /**
     * @type {Style}
     * @private
     */
    this.style_ = style;

    /**
     * @type {number}
     * @private
     */
    this.cacheSize_ = cacheSize;

    /**
     * @type {Object<string, (string|number)>}
     * @private
     */
    this.styleVariables_ = this.style_.variables || {};

    this.addChangeListener(LayerProperty.SOURCE, this.handleSourceUpdate_);
  }

  /**
   * Gets the sources for this layer, for a given extent and resolution.
   * @param {import("../extent.js").Extent} extent Extent.
   * @param {number} resolution Resolution.
   * @return {Array<SourceType>} Sources.
   */
  getSources(extent, resolution) {
    const source = this.getSource();
    return this.sources_
      ? typeof this.sources_ === 'function'
        ? this.sources_(extent, resolution)
        : this.sources_
      : source
      ? [source]
      : [];
  }

  /**
   * @return {SourceType} The source being rendered.
   */
  getRenderSource() {
    return this.renderedSource_ || this.getSource();
  }

  /**
   * @return {import("../source/Source.js").State} Source state.
   */
  getSourceState() {
    const source = this.getRenderSource();
    return source ? source.getState() : 'undefined';
  }

  /**
   * @private
   */
  handleSourceUpdate_() {
    if (this.hasRenderer()) {
      this.getRenderer().clearCache();
    }
    if (this.getSource()) {
      this.setStyle(this.style_);
    }
  }

  /**
   * @private
   * @return {number} The number of source bands.
   */
  getSourceBandCount_() {
    const max = Number.MAX_SAFE_INTEGER;
    const sources = this.getSources([-max, -max, max, max], max);
    return sources && sources.length && 'bandCount' in sources[0]
      ? sources[0].bandCount
      : 4;
  }

  createRenderer() {
    const parsedStyle = parseStyle(this.style_, this.getSourceBandCount_());

    return new WebGLTileLayerRenderer(this, {
      vertexShader: parsedStyle.vertexShader,
      fragmentShader: parsedStyle.fragmentShader,
      uniforms: parsedStyle.uniforms,
      cacheSize: this.cacheSize_,
      paletteTextures: parsedStyle.paletteTextures,
    });
  }

  /**
   * @param {import("../Map").FrameState} frameState Frame state.
   * @param {Array<SourceType>} sources Sources.
   * @return {HTMLElement} Canvas.
   */
  renderSources(frameState, sources) {
    const layerRenderer = this.getRenderer();
    let canvas;
    for (let i = 0, ii = sources.length; i < ii; ++i) {
      this.renderedSource_ = sources[i];
      if (layerRenderer.prepareFrame(frameState)) {
        canvas = layerRenderer.renderFrame(frameState);
      }
    }
    return canvas;
  }

  /**
   * @param {?import("../Map.js").FrameState} frameState Frame state.
   * @param {HTMLElement} target Target which the renderer may (but need not) use
   * for rendering its content.
   * @return {HTMLElement} The rendered element.
   */
  render(frameState, target) {
    this.rendered = true;
    const viewState = frameState.viewState;
    const sources = this.getSources(frameState.extent, viewState.resolution);
    let ready = true;
    for (let i = 0, ii = sources.length; i < ii; ++i) {
      const source = sources[i];
      const sourceState = source.getState();
      if (sourceState == 'loading') {
        const onChange = () => {
          if (source.getState() == 'ready') {
            source.removeEventListener('change', onChange);
            this.changed();
          }
        };
        source.addEventListener('change', onChange);
      }
      ready = ready && sourceState == 'ready';
    }
    const canvas = this.renderSources(frameState, sources);
    if (this.getRenderer().renderComplete && ready) {
      // Fully rendered, done.
      this.renderedResolution_ = viewState.resolution;
      return canvas;
    }
    // Render sources from previously fully rendered frames
    if (this.renderedResolution_ > 0.5 * viewState.resolution) {
      const altSources = this.getSources(
        frameState.extent,
        this.renderedResolution_
      ).filter((source) => !sources.includes(source));
      if (altSources.length > 0) {
        return this.renderSources(frameState, altSources);
      }
    }
    return canvas;
  }

  /**
   * Update the layer style.  The `updateStyleVariables` function is a more efficient
   * way to update layer rendering.  In cases where the whole style needs to be updated,
   * this method may be called instead.  Note that calling this method will also replace
   * any previously set variables, so the new style also needs to include new variables,
   * if needed.
   * @param {Style} style The new style.
   */
  setStyle(style) {
    this.styleVariables_ = style.variables || {};
    this.style_ = style;
    const parsedStyle = parseStyle(this.style_, this.getSourceBandCount_());
    const renderer = this.getRenderer();
    renderer.reset({
      vertexShader: parsedStyle.vertexShader,
      fragmentShader: parsedStyle.fragmentShader,
      uniforms: parsedStyle.uniforms,
    });
    this.changed();
  }

  /**
   * Update any variables used by the layer style and trigger a re-render.
   * @param {Object<string, number>} variables Variables to update.
   * @api
   */
  updateStyleVariables(variables) {
    Object.assign(this.styleVariables_, variables);
    this.changed();
  }
}

/**
 * Clean up underlying WebGL resources.
 * @function
 * @api
 */
WebGLTileLayer.prototype.dispose;

export default WebGLTileLayer;
