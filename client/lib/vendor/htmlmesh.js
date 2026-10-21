// Vendored from three examples/jsm/interactive/HTMLMesh.js (MIT — notice in ./LICENSE-three-MIT.txt) for eido's VR
// quads (2026-09-05, from 0.185.1). It differs from the installed three's copy by the EIDO patches below plus upstream
// drift; to see the difference: `diff client/lib/vendor/htmlmesh.js client/node_modules/three/examples/jsm/interactive/HTMLMesh.js`.
// Used by domquad.js (VR quads, part 4) and platecard.js (the nameplate card in VR); inert on the desktop.
// Patches, each marked EIDO: (1) DPR scale — canvas rasterised at `scale` px per CSS px so the quad
// matches xrpanels' 900 px/m; (2) inline <svg> drawn via serialise→Image (the icon system);
// (3) `pause`/`resume` + a per-instance min interval so live panels don't re-rasterise at 60 Hz;
// (4) events are NOT re-dispatched on window (three's did — it tripped desktop handlers);
// (8) wrapped text nodes draw word by word; (9) unpainted elements (opacity 0, CSS display/visibility) are skipped; (10) colour inputs are swatches;
// (13) a <textarea> draws its value wrapped (by word, then by character) from its scroll position, and a press focuses it;(11) a native <select> draws its label; (12) partial opacity composites as a group, like the browser; (5) elementAt/scrollAt for trigger-scroll; (7) a pick targets ONE element and bubbles; (6) `suspend`/`unsuspend` — the DOM observer off while a
// kept quad's element is back on the desktop (domquad's soft swap).
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

		this.observer = observer; this.observerConfig = config;   // EIDO (6)

	}

	dispatchDOMEvent( event ) {

		if ( event.data ) {

			htmlevent( this.dom, event.type, event.data.x, event.data.y );

		}

	}

	// EIDO (5): the deepest element under a uv hit, and a scroll on its nearest scrollable ancestor (live 09-07 22:57:
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
	// EIDO (6): a quad kept across sessions (domquad soft swap) stops WATCHING while its element lives on the desktop
	suspend() { this.suspended = true; this.observer?.disconnect(); this.scheduleUpdate = clearTimeout( this.scheduleUpdate ); layers.delete( this.image ); }   // EIDO (12): the opacity layers are rebuilt at the next raster
	unsuspend() { if ( ! this.suspended ) return; this.suspended = false; this.observer?.observe( this.dom, this.observerConfig ); }
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
		layers.delete( this.image );   // EIDO (12)

		super.dispose();

	}

}


//

const canvases = new WeakMap();
const layers = new WeakMap();   // EIDO (12): raster canvas → its opacity layers, by depth

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

	function drawElement( element, style, layered = false ) {

		// Do not render invisible elements, comments and scripts.
		if ( element.nodeType === Node.COMMENT_NODE || element.nodeName === 'SCRIPT' || ( element.style && element.style.display === 'none' ) ) {

			return;

		}

		// EIDO (9): what the browser does not PAINT, the quad must not paint. three checked only an inline display:none, so a
		// control hidden by CSS was drawn anyway: the house dropdown keeps each native <select> as its value store at
		// opacity:0, 1×1 px (dropdown.js, index.html select.dd-native) and the quad drew it, background plus EVERY option's
		// text stacked in one spot: the "little black squares like checkboxes" over World › Sky's labels (owner, 09-30).
		// Opacity 0 and display:none take the subtree; visibility:hidden too (a visible child inside one is rare here).
		let cs = null;
		if ( element.nodeType === Node.ELEMENT_NODE ) {

			cs = window.getComputedStyle( element );
			const op = parseFloat( cs.opacity );
			if ( cs.display === 'none' || cs.visibility === 'hidden' || op === 0 ) return;
			// EIDO (12): PARTIAL opacity is a group opacity, as the browser composites it: the element and its subtree are
			// drawn into a layer, and the layer lands at `op` (nested layers multiply down the chain). Skipped, a dimmed
			// control (a disabled range at .5, a dead row at .42) read fully live on the quad (owner, 09-30). A layer, not
			// ctx.globalAlpha per paint: a translucent button's label over its own background would double-dim.
			if ( op < 1 && ! layered ) {

				drawLayer( element, style, op );
				return;

			}

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

			// EIDO (8): a text node that WRAPS spans several line boxes; drawn as one fillText at its bounding box it
			// started at the box's left (over a chat line's name) and left the wrapped lines empty (the owner's
			// headset pass, 09-27). Wrapped nodes draw word by word, each at its own laid-out position.
			if ( range.getClientRects().length > 1 ) {

				const text = element.nodeValue, re = /\S+/g;
				let m;
				while ( ( m = re.exec( text ) ) !== null ) {

					range.setStart( element, m.index ); range.setEnd( element, m.index + m[ 0 ].length );
					const r = range.getBoundingClientRect();
					if ( r.width > 0 ) drawText( style, r.left - offset.left - 0.5, r.top - offset.top - 0.5, m[ 0 ] );

				}

			} else {

				drawText( style, x, y, element.nodeValue.trim() );

			}

		} else if ( element instanceof SVGSVGElement ) {   // EIDO (2): the icon system is inline <svg>
			const r = element.getBoundingClientRect(); const x = r.left - offset.left, y = r.top - offset.top, w = r.width, h = r.height;
			if ( ! element.__eidoImg ) {
				const img = new Image();
				const clone = element.cloneNode( true );
				clone.style.opacity = ''; clone.removeAttribute( 'opacity' );   // EIDO (12): a dimmed icon's opacity is its layer's; kept here too, it dimmed twice
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

			style = cs;

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

				// EIDO (10): a colour input is a SWATCH, not its value as text: three drew '#8fe8c8' clipped into a 26 px box
				// (Settings › Style in a headset, owner 09-30). Fill the content box with the colour, radius as the house
				// ::-webkit-color-swatch has it (index.html: 3 px inside a 4 px-radius, 1 px border).
				if ( element.type === 'color' ) {

					const bw = parseFloat( style.borderTopWidth ) || 0;
					const pl = parseFloat( style.paddingLeft ) || 0, pt = parseFloat( style.paddingTop ) || 0;
					const pr = parseFloat( style.paddingRight ) || 0, pb = parseFloat( style.paddingBottom ) || 0;
					buildRectPath( x + bw + pl, y + bw + pt, width - 2 * bw - pl - pr, height - 2 * bw - pt - pb, Math.max( 0, parseFloat( style.borderRadius ) - bw ) );
					context.fillStyle = element.value;
					context.fill();

				}

				if ( element.type === 'text' || element.type === 'number' || element.type === 'email' || element.type === 'password' ) {

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

		// EIDO (13): a <textarea> (the chat's compose box grows to several lines, 2026-10-01) draws its value WRAPPED to
		// its box from its scroll position, as the browser lays it out; without this a headset showed an empty box while
		// you typed. A press on it focuses it, as a text input's does (htmlevent, below).
		if ( element instanceof HTMLTextAreaElement ) {

			const pl = ( parseFloat( style.paddingLeft ) || 0 ) + ( parseFloat( style.borderLeftWidth ) || 0 ), pr = ( parseFloat( style.paddingRight ) || 0 ) + ( parseFloat( style.borderRightWidth ) || 0 ), pt = ( parseFloat( style.paddingTop ) || 0 ) + ( parseFloat( style.borderTopWidth ) || 0 );
			const lh = parseFloat( style.lineHeight ) || parseFloat( style.fontSize ) * 1.2;
			context.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
			const maxW = width - pl - pr, rows = [];
			for ( const para of element.value.split( '\n' ) ) {

				let line = '';
				for ( const word of para.split( /(\s+)/ ) ) {

					const t = line + word;
					if ( line && context.measureText( t ).width > maxW ) { rows.push( line ); line = word.trimStart(); } else line = t;
					// a word wider than the box breaks by character, as the browser wraps it (a pasted URL)
					while ( context.measureText( line ).width > maxW && line.length > 1 ) {

						let k = line.length - 1;
						while ( k > 1 && context.measureText( line.slice( 0, k ) ).width > maxW ) k --;
						rows.push( line.slice( 0, k ) ); line = line.slice( k );

					}

				}

				rows.push( line );

			}

			clipper.add( { x: x, y: y, width: width, height: height } );
			rows.forEach( ( r, i ) => drawText( style, x + pl, y + pt + i * lh - element.scrollTop, r ) );
			clipper.remove();
			return;

		}

		// EIDO (11): a VISIBLE native <select> (data-native opts out of the house skin) shows its chosen label; its <option>
		// children are a closed popup's rows, never laid out, and walking them stacked every label in one place.
		if ( element instanceof HTMLSelectElement ) {

			const label = element.selectedOptions[ 0 ]?.textContent ?? '';
			clipper.add( { x: x, y: y, width: width, height: height } );
			drawText( style, x + ( parseFloat( style.paddingLeft ) || 0 ) + ( parseFloat( style.borderLeftWidth ) || 0 ), y + ( height - parseFloat( style.fontSize ) * 1.2 ) / 2, label.trim() );
			clipper.remove();
			return;

		}

		const isClipping = style.overflow === 'auto' || style.overflow === 'hidden';

		if ( isClipping ) clipper.add( { x: x, y: y, width: width, height: height } );

		for ( let i = 0; i < element.childNodes.length; i ++ ) {

			drawElement( element.childNodes[ i ], style );

		}

		if ( isClipping ) clipper.remove();

	}

	// EIDO (12): one layer canvas per nesting depth, reused across rasters. Only the element's own box (+2 px for
	// antialiasing) is cleared and composited — chat's timestamps are each at .6 and a live quad re-rasters at 4 Hz, so
	// a full-canvas clear + draw per dimmed element added up. A descendant overflowing that box is clipped to it.
	function drawLayer( element, style, op ) {

		const r = element.getBoundingClientRect();
		const x0 = Math.max( 0, Math.floor( ( r.left - offset.left - 2 ) * scale ) ), y0 = Math.max( 0, Math.floor( ( r.top - offset.top - 2 ) * scale ) );
		const x1 = Math.min( canvas.width, Math.ceil( ( r.right - offset.left + 2 ) * scale ) ), y1 = Math.min( canvas.height, Math.ceil( ( r.bottom - offset.top + 2 ) * scale ) );
		if ( x1 <= x0 || y1 <= y0 ) return;
		const main = context, mainClipper = clipper;
		const pool = layers.get( canvas ) ?? [];
		layers.set( canvas, pool );
		const layer = pool[ depth ] ?? ( pool[ depth ] = document.createElement( 'canvas' ) );
		if ( layer.width !== canvas.width || layer.height !== canvas.height ) { layer.width = canvas.width; layer.height = canvas.height; }
		context = layer.getContext( '2d' );
		context.setTransform( 1, 0, 0, 1, 0, 0 );
		context.globalAlpha = 1;
		context.clearRect( x0, y0, x1 - x0, y1 - y0 );
		context.setTransform( scale, 0, 0, scale, 0, 0 );
		clipper = new Clipper( context );   // clips inside the subtree; the parent's clips apply when the layer lands
		depth ++;
		try {

			drawElement( element, style, true );

		} finally {

			depth --;
			context = main; clipper = mainClipper;

		}

		main.save();   // balanced, so the Clipper's own save/restore stack is untouched; the clip it holds applies
		main.setTransform( 1, 0, 0, 1, 0, 0 );
		main.globalAlpha *= op;
		main.drawImage( layer, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0 );
		main.restore();

	}

	const offset = element.getBoundingClientRect();

	let canvas = canvases.get( element );

	if ( canvas === undefined ) {

		canvas = document.createElement( 'canvas' );
		canvases.set( element, canvas );

	}

	canvas.width = Math.ceil( offset.width * scale );   // EIDO (1)
	canvas.height = Math.ceil( offset.height * scale );

	let context = canvas.getContext( '2d'/*, { alpha: false }*/ );

	let clipper = new Clipper( context );
	let depth = 0;   // EIDO (12)

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

	// EIDO (7): ONE target, like a browser. three dispatched a non-bubbling event on EVERY element under the point,
	// depth-first, and kept walking into nodes the handlers had just inserted: a trigger on a house dropdown opened
	// its list (appended in the same frame) and the walk then clicked the option under the same point — the value
	// changed and nothing appeared to expand (a headset session, 2026-09-26). The target is the topmost element under
	// the point (the last hit in document order), chosen BEFORE anything is dispatched; the event bubbles from it.
	// Like a browser's hit test, two more rules. A scroll box (overflow other than visible) clips its descendants: a
	// row scrolled out of view, later in document order, must not win over the visible control above it. And a node's
	// OWN pointer-events:none takes it and its subtree out until a descendant sets it back. domquad's offscreen stage
	// sets an inline pointer-events:none so the DESKTOP mouse can't reach it, and that inherits into every staged
	// element, hiding which nones are deliberate. So for the pick only, inline nones on the panel and its ancestors are
	// lifted (and restored before anything is dispatched): the computed styles then show just the panel's own CSS.
	let target = null;
	const lifted = [];
	for ( let n = element; n && n.style; n = n.parentElement ) if ( n.style.pointerEvents === 'none' ) { lifted.push( n ); n.style.pointerEvents = 'auto'; }
	try {
	( function find( node, clip, pe, off ) {

		if ( node.nodeType !== Node.ELEMENT_NODE ) return;
		const st = getComputedStyle( node );
		if ( st.display === 'none' || st.visibility === 'hidden' ) return;
		if ( st.pointerEvents === 'none' && pe !== 'none' ) off = true;
		else if ( st.pointerEvents !== 'none' && pe === 'none' ) off = false;
		const r = node.getBoundingClientRect();
		const inClip = ! clip || ( x > clip.left && x < clip.right && y > clip.top && y < clip.bottom );
		if ( ! off && inClip && x > r.left && x < r.right && y > r.top && y < r.bottom ) target = node;
		if ( st.overflowX !== 'visible' || st.overflowY !== 'visible' ) {
			clip = clip ? { left: Math.max( clip.left, r.left ), top: Math.max( clip.top, r.top ), right: Math.min( clip.right, r.right ), bottom: Math.min( clip.bottom, r.bottom ) } : r;
		}
		for ( let i = 0; i < node.childNodes.length; i ++ ) find( node.childNodes[ i ], clip, st.pointerEvents, off );

	} )( element, null, 'auto', false );
	} finally { for ( const n of lifted ) n.style.pointerEvents = 'none'; }
	if ( ! target ) return;

	target.dispatchEvent( new MouseEvent( event, { ...mouseEventInit, bubbles: true, cancelable: true } ) );

	if ( target instanceof HTMLInputElement && target.type === 'range' && ( event === 'mousedown' || event === 'click' ) ) {

		const r = target.getBoundingClientRect();
		const [ min, max ] = [ 'min', 'max' ].map( property => parseFloat( target[ property ] ) );
		target.value = min + ( max - min ) * ( ( x - r.x ) / r.width );
		target.dispatchEvent( new InputEvent( 'input', { bubbles: true } ) );

	}

	if ( ( target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement && ( target.type === 'text' || target.type === 'number' || target.type === 'email' || target.type === 'password' ) ) && ( event === 'mousedown' || event === 'click' ) ) {

		target.focus();

	}

}

export { HTMLMesh };
