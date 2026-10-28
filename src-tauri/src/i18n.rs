//! Langue des messages du programme (les messages d'erreur remontent jusqu'à l'écran).
//! L'interface choisit la langue au démarrage et à chaque changement.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

fn is_english_code(code: &str) -> bool {
    code.trim().to_lowercase().starts_with("en")
}

pub fn set_language(code: &str) {
    ENGLISH.store(is_english_code(code), Ordering::Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// `tr!("texte {x}", "text {x}", x = …)` : le texte français ou anglais selon la langue choisie.
#[macro_export]
macro_rules! tr {
    ($fr:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        if $crate::i18n::is_english() { format!($en $(, $arg)*) } else { format!($fr $(, $arg)*) }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choix_de_la_langue() {
        assert!(is_english_code("en-US"));
        assert!(is_english_code(" EN "));
        assert!(!is_english_code("fr"));
        assert!(!is_english_code(""));
    }
}
