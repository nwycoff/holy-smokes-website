// Main JavaScript for Holy Smokes Dispensary Website

// DOM Elements
const ageVerification = document.getElementById('age-verification');
const ageYesBtn = document.getElementById('age-yes');
const ageNoBtn = document.getElementById('age-no');
const navToggle = document.getElementById('navToggle');
const navLinks = document.querySelector('.nav-links');
const navLinksItems = document.querySelectorAll('.nav-link');

// Age Verification
function handleAgeVerification() {
    // Check if user has already verified age
    if (localStorage.getItem('ageVerified') === 'true') {
        ageVerification.style.display = 'none';
    } else {
        ageVerification.style.display = 'flex';
        
        // Yes button - hide overlay and set localStorage
        ageYesBtn.addEventListener('click', () => {
            ageVerification.style.display = 'none';
            localStorage.setItem('ageVerified', 'true');
        });
        
        // No button - redirect to Google
        ageNoBtn.addEventListener('click', () => {
            window.location.href = 'https://www.google.com';
        });
    }
}

// Mobile Navigation Toggle
function setupMobileNav() {
    navToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        
        // Animate hamburger to X
        const spans = navToggle.querySelectorAll('span');
        spans.forEach(span => {
            span.classList.toggle('active');
        });
    });
    
    // Close mobile menu when clicking a link
    navLinksItems.forEach(item => {
        item.addEventListener('click', () => {
            if (navLinks.classList.contains('active')) {
                navLinks.classList.remove('active');
                
                // Reset hamburger icon
                const spans = navToggle.querySelectorAll('span');
                spans.forEach(span => {
                    span.classList.remove('active');
                });
            }
        });
    });
}

// Smooth Scrolling for Navigation Links
function setupSmoothScrolling() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            const targetElement = document.querySelector(targetId);
            
            if (targetElement) {
                // Calculate navbar height for offset
                const navbarHeight = document.getElementById('navbar').offsetHeight;
                
                window.scrollTo({
                    top: targetElement.offsetTop - navbarHeight,
                    behavior: 'smooth'
                });
            }
        });
    });
}

// Sticky Navigation
function setupStickyNav() {
    const navbar = document.getElementById('navbar');
    const banner = document.querySelector('.banner');
    
    window.addEventListener('scroll', () => {
        if (window.scrollY > banner.offsetHeight - 100) {
            navbar.classList.add('sticky');
        } else {
            navbar.classList.remove('sticky');
        }
    });
}

// Initialize all functions
function init() {
    handleAgeVerification();
    setupMobileNav();
    setupSmoothScrolling();
    setupStickyNav();
    
    // Add animation to service cards on scroll
    const serviceCards = document.querySelectorAll('.service-card');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.2 });
    
    serviceCards.forEach(card => {
        observer.observe(card);
    });
}

// Run when DOM is fully loaded
document.addEventListener('DOMContentLoaded', init);

// Add CSS for hamburger animation
document.head.insertAdjacentHTML('beforeend', `
<style>
    .nav-toggle span.active:nth-child(1) {
        transform: rotate(45deg) translate(5px, 5px);
    }
    
    .nav-toggle span.active:nth-child(2) {
        opacity: 0;
    }
    
    .nav-toggle span.active:nth-child(3) {
        transform: rotate(-45deg) translate(7px, -6px);
    }
    
    .service-card {
        opacity: 0;
        transform: translateY(20px);
        transition: opacity 0.5s ease, transform 0.5s ease;
    }
    
    .service-card.animate {
        opacity: 1;
        transform: translateY(0);
    }
    
    #navbar.sticky {
        background-color: rgba(27, 27, 27, 0.95);
        padding: 10px 0;
    }
</style>
`);
