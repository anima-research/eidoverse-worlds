// Vendored from three 0.185.1 examples/jsm/interactive/HTMLMesh.js (MIT) for eido's VR quads (2026-09-05); NOT
// rebased onto 0.186's HTMLMesh.js (they differ by ~106 lines: the EIDO patches below plus upstream drift).
// Patches, each marked EIDO: (1) DPR scale — canvas rasterised at `scale` px per CSS px so the quad
// matches xrpanels' 900 px/m; (2) inline <svg> drawn via serialise→Image (the icon system);
// (3) `pause`/`resume` + a per-instance min interval so live panels don't re-rasterise at 60 Hz;
// (4) events are NOT re-dispatched on window (three's did — it tripped desktop handlers).
import {
	CanvasTexture,
	LinearFilter,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	SRGBColorSpace,
	Color
} from 'three';

/**
 * This class can be used to render a DOM element onto a canvas and use it as a texture
 * for a plane mesh.
 *
 * A typical use case for this class is to render the GUI of `lil-gui` as a texture so it
 * is compatible for VR.
 *
 * ```js
 * const gui = new GUI( { width: 300 } ); // create lil-gui instance
 *
 * const mesh = new HTMLMesh( gui.domElement );
 * scene.add( mesh );
 * ```
 *
 * @augments Mesh
 * @three_import import { HTMLMesh } from 'three/addons/interactive/HTMLMesh.js';
 */
class HTMLMesh extends Mesh {

	/**
	 * Constructs a new HTML mesh.
	 *
	 * @param {HTMLElement} dom - The DOM element to display as a plane mesh.
	 */
	constructor( dom, { scale = 1, minInterval = 16 } = {} ) {

		const texture = new HTMLTexture( dom, scale, minInterval );   // EIDO (1)(3)

		const geometry = new PlaneGeometry( texture.image.width / scale * 0.001, texture.image.height / scale * 0.001 );   // EIDO (1): metres from CSS px, not device px
		const material = new MeshBasicMaterial( { map: texture, toneMapped: false, transparent: true } );

		super( geometry, material );

		function onEvent( event ) {

			material.map.dispatchDOMEvent( event );

		}

		this.addEventListener( 'mousedown', onEvent );
		this.addEventListener( 'mousemove', onEvent );
		this.addEventListener( 'mouseup', onEvent );
		this.addEventListener( 'click', onEvent );

		/**
		 * Frees the GPU-related resources allocated by this instance and removes all event listeners.
		 * Call this method whenever this instance is no longer used in your app.
		 */
		this.dispose = function () {

			geometry.dispose();
			material.dispose();

			material.map.dispose();

			canvases.delete( dom );

			this.removeEventListener( 'mousedown', onEvent );
			this.removeEventListener( 'mousemove', onEvent );
			this.removeEventListener( 'mouseup', onEvent );
			this.removeEventListener( 'click', onEvent );

		};

	}

}

class HTMLTexture extends CanvasTexture {

	constructor( dom, scale = 1, minInterval = 16 ) {

		super( html2canvas( dom, scale ) );
		this.scale = scale; this.minInterval = minInterval; this.paused = false; this.lastUpdate = 0;   // EIDO (1)(3)

		this.dom = dom;

		this.anisotropy = 16;
		this.colorSpace = SRGBColorSpace;
		this.minFilter = LinearFilter;
		this.magFilter = LinearFilter;
		this.generateMipmaps = false;

		// Create an observer on the DOM, and run html2canvas update in the next loop
		const observer = new MutationObserver( () => {

			if ( ! this.scheduleUpdate ) {

				// ideally should use xr.requestAnimationFrame, here setTimeout to avoid passing the renderer
				this.scheduleUpdate = setTimeout( () => this.update(), Math.max( 16, this.minInterval - ( performance.now() - this.lastUpdate ) ) );   // EIDO (3)

			}

		} );

		const config = { attributes: true, childList: true, subtree: true, characterData: true };
		observer.observe( dom, config );

		this.observer = observer;

	}

	dispatchDOMEvent( event ) {

		if ( event.data ) {

			htmlevent( this.dom, event.type, event.data.x, event.data.y );

		}

	}

	// EIDO (5): the deepest element under a uv hit, and a scroll on its nearest scrollable ancestor (R 09-07 22:57:
	// 'trigger-to-click and scrolling on the VR panels'). Same rect math as htmlevent; re-rasters through the throttle.
	elementAt( x, y ) {
		const root = this.dom; const rect = root.getBoundingClientRect();
		const px = x * rect.width + rect.left, py = y * rect.height + rect.top;
		let best = null;
		const walk = ( el ) => {
			if ( el.nodeType !== 1 ) return;
			const r = el.getBoundingClientRect();
			if ( r.width === 0 || px < r.left || px > r.right || py < r.top || py > r.bottom ) return;
			best = el;
			for ( const c of el.children ) walk( c );
		};
		walk( root );
		return best;
	}
	scrollAt( x, y, dy ) {
		let el = this.elementAt( x, y );
		while ( el && el !== this.dom.parentElement ) {
			const cs = getComputedStyle( el );
			if ( el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test( cs.overflowY ) ) {
				const before = el.scrollTop; el.scrollTop = before + dy;
				if ( el.scrollTop !== before && ! this.scheduleUpdate ) this.scheduleUpdate = setTimeout( () => this.update(), 16 );
				return el;
			}
			el = el.parentElement;
		}
		return null;
	}
	pause() { this.paused = true; }   // EIDO (3): a quad that isn't shown stops rasterising
	resume() { this.paused = false; this.update(); }

	update() {

		if ( this.paused ) return;
		this.lastUpdate = performance.now();
		this.image = html2canvas( this.dom, this.scale );
		this.needsUpdate = true;

		this.scheduleUpdate = null;

	}

	dispose() {

		if ( this.observer ) {

			this.observer.disconnect();

		}

		this.scheduleUpdate = clearTimeout( this.scheduleUpdate );

		super.dispose();

	}

}


//

const canvases = new WeakMap();

function html2canvas( element, scale = 1 ) {   // EIDO (1)

	const range = document.createRange();
	const color = new Color();

	function Clipper( context ) {

		const clips = [];
		let isClipping = false;

		function doClip() {

			if ( isClipping ) {

				isClipping = false;
				context.restore();

			}

			if ( clips.length === 0 ) return;

			let minX = - Infinity, minY = - Infinity;
			let maxX = Infinity, maxY = Infinity;

			for ( let i = 0; i < clips.length; i ++ ) {

				const clip = clips[ i ];

				minX = Math.max( minX, clip.x );
				minY = Math.max( minY, clip.y );
				maxX = Math.min( maxX, clip.x + clip.width );
				maxY = Math.min( maxY, clip.y + clip.height );

			}

			context.save();
			context.beginPath();
			context.rect( minX, minY, maxX - minX, maxY - minY );
			context.clip();

			isClipping = true;

		}

		return {

			add: function ( clip ) {

				clips.push( clip );
				doClip();

			},

			remove: function () {

				clips.pop();
				doClip();

			}

		};

	}

	function drawText( style, x, y, string ) {

		if ( string !== '' ) {

			if ( style.textTransform === 'uppercase' ) {

				string = string.toUpperCase();

			}

			context.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
			context.textBaseline = 'top';
			context.fillStyle = style.color;
			context.fillText( string, x, y + parseFloat( style.fontSize ) * 0.1 );

		}

	}

	function buildRectPath( x, y, w, h, r ) {

		if ( w < 2 * r ) r = w / 2;
		if ( h < 2 * r ) r = h / 2;

		context.beginPath();
		context.moveTo( x + r, y );
		context.arcTo( x + w, y, x + w, y + h, r );
		context.arcTo( x + w, y + h, x, y + h, r );
		context.arcTo( x, y + h, x, y, r );
		context.arcTo( x, y, x + w, y, r );
		context.closePath();

	}

	function drawBorder( style, which, x, y, width, height ) {

		const borderWidth = style[ which + 'Width' ];
		const borderStyle = style[ which + 'Style' ];
		const borderColor = style[ which + 'Color' ];

		if ( borderWidth !== '0px' && borderStyle !== 'none' && borderColor !== 'transparent' && borderColor !== 'rgba(0, 0, 0, 0)' ) {

			context.strokeStyle = borderColor;
			context.lineWidth = parseFloat( borderWidth );
			context.beginPath();
			context.moveTo( x, y );
			context.lineTo( x + width, y + height );
			context.stroke();

		}

	}

	function drawElement( element, style ) {

		// Do not render invisible elements, comments and scripts.
		if ( element.nodeType === Node.COMMENT_NODE || element.nodeName === 'SCRIPT' || ( element.style && element.style.display === 'none' ) ) {

			return;

		}

		let x = 0, y = 0, width = 0, height = 0;

		if ( element.nodeType === Node.TEXT_NODE ) {

			// text

			range.selectNode( element );

			const rect = range.getBoundingClientRect();

			x = rect.left - offset.left - 0.5;
			y = rect.top - offset.top - 0.5;
			width = rect.width;
			height = rect.height;

			drawText( style, x, y, element.nodeValue.trim() );

		} else if ( element instanceof SVGSVGElement ) {   // EIDO (2): the icon system is inline <svg>
			const r = element.getBoundingClientRect(); const x = r.left - offset.left, y = r.top - offset.top, w = r.width, h = r.height;
			if ( ! element.__eidoImg ) {
				const img = new Image();
				const clone = element.cloneNode( true );
				const cs = window.getComputedStyle( element );
				clone.setAttribute( 'xmlns', 'http://www.w3.org/2000/svg' );
				if ( ! clone.getAttribute( 'width' ) ) clone.setAttribute( 'width', w ); if ( ! clone.getAttribute( 'height' ) ) clone.setAttribute( 'height', h );
				// Chrome computes a color-mix() token as color(srgb …), which the SVG-as-image rasteriser
				// rejects → currentColor fell to BLACK (settings icons missing on the quad, 09-05 23:38).
				// A 2D-context fillStyle round-trip normalises any colour to #rrggbb / rgba().
				const norm = document.createElement( 'canvas' ).getContext( '2d' ); norm.fillStyle = cs.color; const col = norm.fillStyle;
				clone.style.color = col;   // currentColor resolves against this
				for ( const n of clone.querySelectorAll( '[fill="currentColor"], [stroke="currentColor"]' ) ) { if ( n.getAttribute( 'fill' ) === 'currentColor' ) n.setAttribute( 'fill', col ); if ( n.getAttribute( 'stroke' ) === 'currentColor' ) n.setAttribute( 'stroke', col ); }
				if ( clone.getAttribute( 'fill' ) === 'currentColor' ) clone.setAttribute( 'fill', col ); if ( clone.getAttribute( 'stroke' ) === 'currentColor' ) clone.setAttribute( 'stroke', col );
				img.onload = () => { element.__eidoReady = true; element.setAttribute( 'data-eido-raster', '1' ); };   // the attribute change wakes the observer → re-raster
				img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent( new XMLSerializer().serializeToString( clone ) );
				element.__eidoImg = img;
			}
			if ( element.__eidoReady && w > 0 && h > 0 ) context.drawImage( element.__eidoImg, x, y, w, h );
			return;   // children are the SVG's own; never walk them
		} else if ( element instanceof HTMLCanvasElement ) {

			// Canvas element
			const rect = element.getBoundingClientRect();
			x = rect.left - offset.left - 0.5;
			y = rect.top - offset.top - 0.5;
			const width = rect.width;
			const height = rect.height;
			context.drawImage( element, x, y, width, height );

		} else if ( element instanceof HTMLImageElement ) {

			const rect = element.getBoundingClientRect();

			x = rect.left - offset.left - 0.5;
			y = rect.top - offset.top - 0.5;
			width = rect.width;
			height = rect.height;

			context.drawImage( element, x, y, width, height );

		} else {

			const rect = element.getBoundingClientRect();

			x = rect.left - offset.left - 0.5;
			y = rect.top - offset.top - 0.5;
			width = rect.width;
			height = rect.height;

			style = window.getComputedStyle( element );

			// Get the border of the element used for fill and border

			buildRectPath( x, y, width, height, parseFloat( style.borderRadius ) );

			const backgroundColor = style.backgroundColor;

			if ( backgroundColor !== 'transparent' && backgroundColor !== 'rgba(0, 0, 0, 0)' ) {

				context.fillStyle = backgroundColor;
				context.fill();

			}

			// If all the borders match then stroke the round rectangle

			const borders = [ 'borderTop', 'borderLeft', 'borderBottom', 'borderRight' ];

			let match = true;
			let prevBorder = null;

			for ( const border of borders ) {

				if ( prevBorder !== null ) {

					match = ( style[ border + 'Width' ] === style[ prevBorder + 'Width' ] ) &&
					( style[ border + 'Color' ] === style[ prevBorder + 'Color' ] ) &&
					( style[ border + 'Style' ] === style[ prevBorder + 'Style' ] );

				}

				if ( match === false ) break;

				prevBorder = border;

			}

			if ( match === true ) {

				// They all match so stroke the rectangle from before allows for border-radius

				const width = parseFloat( style.borderTopWidth );

				if ( style.borderTopWidth !== '0px' && style.borderTopStyle !== 'none' && style.borderTopColor !== 'transparent' && style.borderTopColor !== 'rgba(0, 0, 0, 0)' ) {

					context.strokeStyle = style.borderTopColor;
					context.lineWidth = width;
					context.stroke();

				}

			} else {

				// Otherwise draw individual borders

				drawBorder( style, 'borderTop', x, y, width, 0 );
				drawBorder( style, 'borderLeft', x, y, 0, height );
				drawBorder( style, 'borderBottom', x, y + height, width, 0 );
				drawBorder( style, 'borderRight', x + width, y, 0, height );

			}

			if ( element instanceof HTMLInputElement ) {

				let accentColor = style.accentColor;

				if ( accentColor === undefined || accentColor === 'auto' ) accentColor = style.color;

				color.set( accentColor );

				const luminance = Math.sqrt( 0.299 * ( color.r ** 2 ) + 0.587 * ( color.g ** 2 ) + 0.114 * ( color.b ** 2 ) );
				const accentTextColor = luminance < 0.5 ? 'white' : '#111111';

				if ( element.type === 'radio' ) {

					buildRectPath( x, y, width, height, height );

					context.fillStyle = 'white';
					context.strokeStyle = accentColor;
					context.lineWidth = 1;
					context.fill();
					context.stroke();

					if ( element.checked ) {

						buildRectPath( x + 2, y + 2, width - 4, height - 4, height );

						context.fillStyle = accentColor;
						context.strokeStyle = accentTextColor;
						context.lineWidth = 2;
						context.fill();
						context.stroke();

					}

				}

				if ( element.type === 'checkbox' ) {

					buildRectPath( x, y, width, height, 2 );

					context.fillStyle = element.checked ? accentColor : 'white';
					context.strokeStyle = element.checked ? accentTextColor : accentColor;
					context.lineWidth = 1;
					context.stroke();
					context.fill();

					if ( element.checked ) {

						const currentTextAlign = context.textAlign;

						context.textAlign = 'center';

						const properties = {
							color: accentTextColor,
							fontFamily: style.fontFamily,
							fontSize: height + 'px',
							fontWeight: 'bold'
						};

						drawText( properties, x + ( width / 2 ), y, '✔' );

						context.textAlign = currentTextAlign;

					}

				}

				if ( element.type === 'range' ) {

					const [ min, max, value ] = [ 'min', 'max', 'value' ].map( property => parseFloat( element[ property ] ) );
					const position = ( ( value - min ) / ( max - min ) ) * ( width - height );

					buildRectPath( x, y + ( height / 4 ), width, height / 2, height / 4 );
					context.fillStyle = accentTextColor;
					context.strokeStyle = accentColor;
					context.lineWidth = 1;
					context.fill();
					context.stroke();

					buildRectPath( x, y + ( height / 4 ), position + ( height / 2 ), height / 2, height / 4 );
					context.fillStyle = accentColor;
					context.fill();

					buildRectPath( x + position, y, height, height, height / 2 );
					context.fillStyle = accentColor;
					context.fill();

				}

				if ( element.type === 'color' || element.type === 'text' || element.type === 'number' || element.type === 'email' || element.type === 'password' ) {

					clipper.add( { x: x, y: y, width: width, height: height } );

					const displayValue = element.type === 'password' ? '*'.repeat( element.value.length ) : element.value;

					drawText( style, x + parseInt( style.paddingLeft ), y + parseInt( style.paddingTop ), displayValue );

					clipper.remove();

				}

			}

		}

		/*
		// debug
		context.strokeStyle = '#' + Math.random().toString( 16 ).slice( - 3 );
		context.strokeRect( x - 0.5, y - 0.5, width + 1, height + 1 );
		*/

		const isClipping = style.overflow === 'auto' || style.overflow === 'hidden';

		if ( isClipping ) clipper.add( { x: x, y: y, width: width, height: height } );

		for ( let i = 0; i < element.childNodes.length; i ++ ) {

			drawElement( element.childNodes[ i ], style );

		}

		if ( isClipping ) clipper.remove();

	}

	const offset = element.getBoundingClientRect();

	let canvas = canvases.get( element );

	if ( canvas === undefined ) {

		canvas = document.createElement( 'canvas' );
		canvases.set( element, canvas );

	}

	canvas.width = Math.ceil( offset.width * scale );   // EIDO (1)
	canvas.height = Math.ceil( offset.height * scale );

	const context = canvas.getContext( '2d'/*, { alpha: false }*/ );

	const clipper = new Clipper( context );

	// console.time( 'drawElement' );

	context.clearRect( 0, 0, canvas.width, canvas.height );
	context.setTransform( scale, 0, 0, scale, 0, 0 );   // EIDO (1): draw in CSS px, rasterise at scale

	drawElement( element );

	// console.timeEnd( 'drawElement' );

	return canvas;

}

function htmlevent( element, event, x, y ) {

	const mouseEventInit = {
		clientX: ( x * element.offsetWidth ) + element.offsetLeft,
		clientY: ( y * element.offsetHeight ) + element.offsetTop,
		view: element.ownerDocument.defaultView
	};

	// EIDO (4): three dispatched on window here — a VR click became a desktop MouseEvent at clientX/Y.

	const rect = element.getBoundingClientRect();

	x = x * rect.width + rect.left;
	y = y * rect.height + rect.top;

	function traverse( element ) {

		if ( element.nodeType !== Node.TEXT_NODE && element.nodeType !== Node.COMMENT_NODE ) {

			const rect = element.getBoundingClientRect();

			if ( x > rect.left && x < rect.right && y > rect.top && y < rect.bottom ) {

				element.dispatchEvent( new MouseEvent( event, mouseEventInit ) );

				if ( element instanceof HTMLInputElement && element.type === 'range' && ( event === 'mousedown' || event === 'click' ) ) {

					const [ min, max ] = [ 'min', 'max' ].map( property => parseFloat( element[ property ] ) );

					const width = rect.width;
					const offsetX = x - rect.x;
					const proportion = offsetX / width;
					element.value = min + ( max - min ) * proportion;
					element.dispatchEvent( new InputEvent( 'input', { bubbles: true } ) );

				}

				if ( element instanceof HTMLInputElement && ( element.type === 'text' || element.type === 'number' || element.type === 'email' || element.type === 'password' ) && ( event === 'mousedown' || event === 'click' ) ) {

					element.focus();

				}

			}

			for ( let i = 0; i < element.childNodes.length; i ++ ) {

				traverse( element.childNodes[ i ] );

			}

		}

	}

	traverse( element );

}

export { HTMLMesh };
