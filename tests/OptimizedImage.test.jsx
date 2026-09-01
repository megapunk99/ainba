/**
 * Tests for OptimizedImage component
 * 
 * Tests the lazy-loading image component:
 * - Renders fallback with initials when src is missing
 * - Renders fallback on image error
 * - Shows placeholder shimmer while loading
 * - Fades in after image loads
 * - Uses IntersectionObserver for lazy loading
 * - Applies custom styling and dimensions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OptimizedImage from '../src/components/OptimizedImage.jsx';

describe('OptimizedImage', () => {
  describe('fallback / error state', () => {
    it('renders fallback with fallbackText when src is empty', () => {
      render(
        <OptimizedImage
          src=""
          alt="Boston Celtics"
          fallbackText="BOS"
          width={40}
          height={40}
        />
      );

      expect(screen.getByText('BOS')).toBeInTheDocument();
    });

    it('renders fallback with first 2 chars of alt when no fallbackText', () => {
      render(
        <OptimizedImage
          src=""
          alt="Celtics"
          width={40}
          height={40}
        />
      );

      expect(screen.getByText('Ce')).toBeInTheDocument();
    });

    it('renders ? when no src and no alt', () => {
      render(
        <OptimizedImage
          src=""
          width={40}
          height={40}
        />
      );

      expect(screen.getByText('?')).toBeInTheDocument();
    });

    it('renders fallback div with correct dimensions', () => {
      const { container } = render(
        <OptimizedImage
          src=""
          alt="Test"
          fallbackText="T"
          width={60}
          height={60}
        />
      );

      const fallback = container.querySelector('.opt-img-fallback');
      expect(fallback).toBeInTheDocument();
      expect(fallback).toHaveStyle({ width: '60px', height: '60px' });
    });

    it('applies placeholderColor to fallback background', () => {
      const { container } = render(
        <OptimizedImage
          src=""
          alt="Test"
          fallbackText="T"
          placeholderColor="#E03A3E"
          width={40}
          height={40}
        />
      );

      const fallback = container.querySelector('.opt-img-fallback');
      expect(fallback).toHaveStyle({ background: '#E03A3E' });
    });

    it('applies className to fallback', () => {
      const { container } = render(
        <OptimizedImage
          src=""
          fallbackText="X"
          className="my-class"
          width={40}
          height={40}
        />
      );

      const fallback = container.querySelector('.opt-img-fallback');
      expect(fallback).toHaveClass('my-class');
    });
  });

  describe('loaded state', () => {
    it('renders image element when in view', () => {
      render(
        <OptimizedImage
          src="https://example.com/logo.png"
          alt="Team Logo"
          width={40}
          height={40}
        />
      );

      const img = document.querySelector('img');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', 'https://example.com/logo.png');
      expect(img).toHaveAttribute('alt', 'Team Logo');
    });

    it('sets lazy loading attribute on img', () => {
      render(
        <OptimizedImage
          src="https://example.com/img.png"
          alt="Test"
          width={40}
          height={40}
        />
      );

      const img = document.querySelector('img');
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('decoding', 'async');
    });

    it('shows placeholder shimmer before image loads', () => {
      const { container } = render(
        <OptimizedImage
          src="https://example.com/slow.png"
          alt="Test"
          width={40}
          height={40}
          placeholderColor="#333"
        />
      );

      const placeholder = container.querySelector('.opt-img-placeholder');
      expect(placeholder).toBeInTheDocument();
    });

    it('hides placeholder after image loads', () => {
      const { container } = render(
        <OptimizedImage
          src="https://example.com/ok.png"
          alt="Test"
          width={40}
          height={40}
        />
      );

      const img = document.querySelector('img');
      fireEvent.load(img);

      const placeholder = container.querySelector('.opt-img-placeholder');
      expect(placeholder).not.toBeInTheDocument();
    });

    it('shows fallback after image error', () => {
      render(
        <OptimizedImage
          src="https://example.com/broken.png"
          alt="Team"
          fallbackText="TM"
          width={40}
          height={40}
        />
      );

      const img = document.querySelector('img');
      fireEvent.error(img);

      expect(screen.getByText('TM')).toBeInTheDocument();
      expect(document.querySelector('img')).not.toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('applies borderRadius from style prop', () => {
      const { container } = render(
        <OptimizedImage
          src=""
          fallbackText="X"
          width={40}
          height={40}
          style={{ borderRadius: '8px' }}
        />
      );

      const fallback = container.querySelector('.opt-img-fallback');
      expect(fallback).toHaveStyle({ borderRadius: '8px' });
    });

    it('defaults to borderRadius 50% (circular)', () => {
      const { container } = render(
        <OptimizedImage
          src=""
          fallbackText="X"
          width={40}
          height={40}
        />
      );

      const fallback = container.querySelector('.opt-img-fallback');
      expect(fallback).toHaveStyle({ borderRadius: '50%' });
    });

    it('applies custom className to wrapper', () => {
      const { container } = render(
        <OptimizedImage
          src="https://example.com/img.png"
          alt="Test"
          className="team-logo"
          width={40}
          height={40}
        />
      );

      const wrapper = container.querySelector('.opt-img-wrap');
      expect(wrapper).toHaveClass('team-logo');
    });

    it('passes through extra props', () => {
      const { container } = render(
        <OptimizedImage
          src="https://example.com/img.png"
          alt="Test"
          width={40}
          height={40}
          data-testid="my-image"
        />
      );

      const wrapper = container.querySelector('[data-testid="my-image"]');
      expect(wrapper).toBeInTheDocument();
    });
  });

  describe('placeholder shimmer animation', () => {
    it('placeholder has shimmer animation styles', () => {
      const { container } = render(
        <OptimizedImage
          src="https://example.com/img.png"
          alt="Test"
          placeholderColor="#FF5733"
          width={40}
          height={40}
        />
      );

      const placeholder = container.querySelector('.opt-img-placeholder');
      expect(placeholder).toBeInTheDocument();
      // Verify shimmer animation is applied
      const style = placeholder.getAttribute('style');
      expect(style).toContain('optImgShimmer');
      expect(style).toContain('linear-gradient');
      expect(style).toContain('absolute');
      // jsdom converts hex to rgba, so check for the RGB values of #FF5733
      expect(style).toContain('rgba(255, 87, 51');
    });
  });
});
