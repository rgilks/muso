use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WorkletWrapper {}

#[wasm_bindgen]
impl WorkletWrapper {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WorkletWrapper {
        WorkletWrapper {}
    }
    #[wasm_bindgen]
    pub fn process_block(_inputs_ptr: *const f32, _outputs_ptr: *mut f32, _frames: usize) -> bool {
        // Placeholder: actual DSP is in `dsp` crate, called from JS for simplicity
        true
    }
}
